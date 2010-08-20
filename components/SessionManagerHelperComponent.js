/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Michael Kraft.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
const report = Components.utils.reportError;

// Browser preferences
const BROWSER_STARTUP_PAGE_PREFERENCE = "browser.startup.page";
const BROWSER_WARN_ON_QUIT = "browser.warnOnQuit";
const BROWSER_TABS_WARN_ON_CLOSE = "browser.tabs.warnOnClose";

// Tab Mix Plus preference
const TMP_PROTECTED_TABS_WARN_ON_CLOSE = "extensions.tabmix.protectedtabs.warnOnClose";

// Session Manager preferences
const OLD_BROWSER_STARTUP_PAGE_PREFERENCE = "old_startup_page";
const SM_BACKUP_SESSION_PREFERENCE = "backup_session";
const SM_ENCRYPT_SESSIONS_PREFERENCE = "encrypt_sessions";
const SM_RESUME_SESSION_PREFERENCE = "resume_session";
const SM_STARTUP_PREFERENCE = "startup";
const SM_SHUTDOWN_ON_LAST_WINDOW_CLOSED_PREFERENCE = "shutdown_on_last_window_close";

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// Session Manager's helper component.  It handles the following:
// 1. Searching command line arguments for sessions to load
// 2. Restoring the cache if cache fixer is enabled
// 3. Clearing autosave preference on a crash if crash recovery is disabled
// 4. Putting up the crash prompt in Firefox 3.5+ and SeaMonkey 2.0+
// 5. Handle saving session data when entering private browsing mode.
// 6. Kick off the initial window restored processing when SessionStore restores all windows at startup
// 7. Force saving of the preference file upon notification
// 8. Handles syncing the Firefox and Session Manager startup preferences.  
// 9. Handles saving and restoring browser startup preference at startup and shutdown (if need be).
// 10. Handles displaying the Session Manager shut down prompt and overriding the browser and Tab Mix Plus's prompts.
// 11. Prevent shutdown when encryption change is in progress
// 12. Check for when initial window load is complete at startup to kick off saving crashed windows (if needed) and caching sessions.
//
function SessionManagerHelperComponent() {
	try {
		Cu.import("resource://sessionmanager/modules/logger.jsm");
		Cu.import("resource://sessionmanager/modules/preference_manager.jsm");
		Cu.import("resource://sessionmanager/modules/session_manager.jsm");
	}
	catch(ex) {
		report(ex);
	}
};

SessionManagerHelperComponent.prototype = {
	// registration details
	classDescription: "Session Manager Helper Component",
	classID:          Components.ID("{5714d620-47ce-11db-b0de-0800200c9a66}"),
	contractID:       "@morac/sessionmanager-helper;1",
	// profile-after-change can only be registered in Firefox 3.5 and higher so need to add it as
	// an event listener in "app-startup" notification in Firefox 3.0.
	_xpcom_categories: [{ category: "app-startup", service: true }, { category: "profile-after-change"},
	                    { category: "command-line-handler", entry: "SessionManagerHelperComponent" }],
						
	// State variables
	_ignorePrefChange: false,
	_warnOnQuit: null,
	_warnOnClose: null,
	_sessionStore_windows_restored: 0,
	_sessionManager_windows_loaded: 0,
	_TMP_protectedtabs_warnOnClose: null,
	_encryption_in_progress: false,
	_tried_to_quit: false,
	
	// interfaces supported
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsICommandLineHandler]),

	/* nsICommandLineHandler */
	handle : function clh_handle(cmdLine)
	{
		// Find and remove the *.session command line argument and save it to a preference
		let data = cmdLine.state;
		let found = false;
		try {
			let i=0;
			while (i<cmdLine.length) {
				let name = cmdLine.getArgument(i);
				if (/^.*\.session$/.test(name)) {
					// Try using absolute path first and if that doesn't work, search for the file in the session folder
					var file = null;
					try {
						file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
						file.initWithPath(name);
					}
					catch (ex) {
						file = null;
					}
					if (!file) {
						file = gSessionManager.getSessionDir(name);
					}
					if (file && file.exists() && file.isFile()) {
						cmdLine.removeArguments(i,i);
						found = true;
						// strip off path if specified
						data = data + "\n" + file.path;
					}
					else {
						i++;
						log("SessionManagerHelperComponent: Command line specified session file not found or is not valid - " + name, "ERROR");
					}
				}
				else i++;
			}
		}
		catch (ex) {
			logError(ex);
		}
		if (found) {
			gSessionManager._temp_restore = data;
		}
	},
	
	// observer
	observe: function(aSubject, aTopic, aData)
	{
		let os = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
		
		//dump(aTopic + "\n");
		log("SessionManagerHelperComponent observer: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "app-startup":
			// Need to register for "profile-after-change" here in Firefox 3.0
			if (VERSION_COMPARE_SERVICE.compare(Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).platformVersion,"1.9.1a1pre") < 0) {
				os.addObserver(this, "profile-after-change", false);
			}
			break;
		case "private-browsing-change-granted":
			this.handlePrivacyChange(aSubject, aData);
			break;
		case "profile-after-change":
			// Register for other notifications
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
			os.addObserver(this, "sessionstore-windows-restored", false);
			os.addObserver(this, "profile-change-teardown", false);
			os.addObserver(this, "private-browsing-change-granted", false);
			os.addObserver(this, "sessionmanager:windows-restored", false);
			os.addObserver(this, "sessionmanager:window-loaded", false);
		
			// Need to unregister here in Firefox 3.0
			if (VERSION_COMPARE_SERVICE.compare(Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).platformVersion,"1.9.1a1pre") < 0) {
				os.removeObserver(this, aTopic);
			}
			try
			{
				// Call the gPreferenceManager Module's initialize procedure
				gPreferenceManager.initialize();
				
				try {
					// This shouldn't throw an exception anymore, but if it does catch it.
					this._restoreCache();
				}
				catch (ex) { logError(ex); }
				
				// Call the gSessionManager Module's initialize procedure
				gSessionManager.initialize();
			}
			catch (ex) { logError(ex); }
			break;
		case "final-ui-startup":
			os.removeObserver(this, aTopic);
			try
			{
				this._handle_crash();
			}
			catch (ex) { logError(ex); }
			
			// stuff to handle preference file saving
			this.mTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			os.addObserver(this, "quit-application-requested", false);
			os.addObserver(this, "quit-application-granted", false);
			// The following two notifications, added in Firefox 3.6, occur when the last browser window closes, but the application isn't actually quitting.  
			os.addObserver(this, "browser-lastwindow-close-requested", false);
			os.addObserver(this, "browser-lastwindow-close-granted", false);
			os.addObserver(this, "sessionmanager-preference-save", false);
			os.addObserver(this, "sessionmanager:restore-startup-preference", false);
			os.addObserver(this, "sessionmanager:ignore-preference-changes", false);
			os.addObserver(this, "sessionmanager:encryption-change", false);
			
			// Observe startup preference
			gPreferenceManager.observe(BROWSER_STARTUP_PAGE_PREFERENCE, this, false, true);
			break;
		case "sessionmanager:encryption-change":
			this._encryption_in_progress = (aData == "start");
			if (!this._encryption_in_progress && this._tried_to_quit) {
				let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
				gSessionManager.threadSafeAlert(bundle.GetStringFromName("encryption_change_done"));
			}
			this._tried_to_quit = false;
			break;
		case "sessionmanager:window-loaded":
			// When Session Manager has finished processing the "onLoad" event for the same number of windows that
			// SessionStore reported was restored, then tell all the browser widnows that the initial session has been restored.
			this._sessionManager_windows_loaded = this._sessionManager_windows_loaded + 1;
			this._check_for_window_restore_complete();
			break;
		case "sessionstore-windows-restored":
			// Currently this is only called once per browsing session, but unregister it anyway just in case
			os.removeObserver(this, aTopic);
			
			// only process if Session Manager isn't loading crashed session
			if (!gSessionManager._crash_session_filename) 
			{
				// Get how many windows SessionStore restored so Session Manager knows how many loaded windows to wait for before
				// processing the initial restore.  Every window except last one will "load" before this notification occurs so 
				// check for restored equals loaded here as well.
				try {
					// On initial SessionStore load, the number of restored windows will be equal to the number of browser windows
					this._sessionStore_windows_restored = gSessionManager.getBrowserWindows().length;
					this._check_for_window_restore_complete();
				}
				catch (ex) { logError(ex); }
			}
			break;
		case "sessionmanager:windows-restored":
			os.removeObserver(this, aTopic);
			
			this._sessionStore_windows_restored = aData;
			this._check_for_window_restore_complete();
			break;
		case "sessionstore-state-read":
			os.removeObserver(this, aTopic);
			try 
			{
				this._check_for_crash(aSubject);
			}
			catch (ex) { logError(ex); }
			break;
		case "sessionmanager-preference-save":
			// Save preference file after one 1/4 second to delay in case another preference changes at same time as first
			this.mTimer.cancel();
			this.mTimer.initWithCallback({
				notify:function (aTimer) { Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).savePrefFile(null); }
			}, 250, Ci.nsITimer.TYPE_ONE_SHOT);
			break;
		case "sessionmanager:restore-startup-preference":
			os.removeObserver(this, aTopic);
			this._ignorePrefChange = true;
			try 
			{
				// Restore browser startup preference if Session Manager previously saved it, otherwise backup current browser startup preference
				if (gPreferenceManager.has(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
					gPreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, gPreferenceManager.get(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, 1), true);
				}
				else {
					gPreferenceManager.set(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, gPreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true));
				}
			}
			catch (ex) { logError(ex); }
			this._ignorePrefChange = false;
			break;
		case "sessionmanager:ignore-preference-changes":
			this._ignorePrefChange = (aData == "true");
			break;
		// quitting or closing last browser window
		case "browser-lastwindow-close-requested":
		case "quit-application-requested":
			this.handleQuitApplicationRequest(aSubject, aTopic, aData);
			break;
		case "browser-lastwindow-close-granted":
			if (typeof(this._warnOnQuit) == "boolean") {
				gPreferenceManager.set(BROWSER_WARN_ON_QUIT, this._warnOnQuit, true);
			}
			if (typeof(this._warnOnClose) == "boolean") {
				gPreferenceManager.set(BROWSER_TABS_WARN_ON_CLOSE, this._warnOnClose, true);
			}
			if (typeof(this._TMP_protectedtabs_warnOnClose) == "boolean") {
				gPreferenceManager.set(TMP_PROTECTED_TABS_WARN_ON_CLOSE, this._TMP_protectedtabs_warnOnClose, true);
			}
			break;
		case "quit-application-granted":
			if (typeof(this._warnOnQuit) == "boolean") {
				gPreferenceManager.set(BROWSER_WARN_ON_QUIT, this._warnOnQuit, true);
			}
			if (typeof(this._warnOnClose) == "boolean") {
				gPreferenceManager.set(BROWSER_TABS_WARN_ON_CLOSE, this._warnOnClose, true);
			}
			if (typeof(this._TMP_protectedtabs_warnOnClose) == "boolean") {
				gPreferenceManager.set(TMP_PROTECTED_TABS_WARN_ON_CLOSE, this._TMP_protectedtabs_warnOnClose, true);
			}
			os.removeObserver(this, "sessionmanager:encryption-change");
			os.removeObserver(this, "sessionmanager-preference-save");
			os.removeObserver(this, "sessionmanager:ignore-preference-changes");
			os.removeObserver(this, "quit-application-requested");
			os.removeObserver(this, "browser-lastwindow-close-requested");
			os.removeObserver(this, "browser-lastwindow-close-granted");
			os.removeObserver(this, aTopic);
			
			// Remove preference observer
			gPreferenceManager.unobserve(BROWSER_STARTUP_PAGE_PREFERENCE, this, true);
			break;
		case "profile-change-teardown":
			let page = gPreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);
			// If Session Manager is handling startup, save the current startup preference and then set it to home page
			// otherwise clear the saved startup preference
			if ((page == 3) && gPreferenceManager.get(SM_STARTUP_PREFERENCE)) {
				gPreferenceManager.set(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, page);
				gPreferenceManager.delete(BROWSER_STARTUP_PAGE_PREFERENCE, true);
			}
			else if (gPreferenceManager.has(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
				gPreferenceManager.delete(OLD_BROWSER_STARTUP_PAGE_PREFERENCE);
			}
			break;
		case "nsPref:changed":
			switch(aData) 
			{
				case BROWSER_STARTUP_PAGE_PREFERENCE:
					// Handle case where user changes browser startup preference
					if (!this._ignorePrefChange) this._synchStartup();
					break;
			}
			break;
		}
	},

	/* ........ private methods .............. */
	
	// This will send out notifications to Session Manager windows when the number of loaded windows equals the number of
	// restored windows
	_check_for_window_restore_complete: function sm_check_for_window_restore_complete()
	{
		log("_check_for_window_restore_complete: SessionStore windows restored = " + this._sessionStore_windows_restored + ", SessionManager windows loaded = " + this._sessionManager_windows_loaded, "DATA");
		if (this._sessionManager_windows_loaded == this._sessionStore_windows_restored) {
			// Stop counting loaded windows and reset count
			gSessionManager._countWindows = false;
			this._sessionManager_windows_loaded = this._sessionStore_windows_restored = 0;
			Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService).notifyObservers(null, "sessionmanager:initial-windows-restored", null); 
			
			// Save window sessions from crashed session in the background
			if (gSessionManager._crash_session_filename) {
				let window = gSessionManager.getMostRecentWindow();
				if (window) {
					gSessionManager._screen_width = window.screen.width;
					gSessionManager._screen_height = window.screen.height;
				}
			
				// Save crashed windows
				gSessionManager.saveCrashedWindowSessions();
				gSessionManager._screen_width = null;
				gSessionManager._screen_height = null;
				log("SessionManagerHelperComponent _check_for_window_restore_complete: Open Window Sessions at time of crash saved.", "TRACE");
			}
			
			// cache session data
			gSessionManager.cacheSessions();
		}
	},

	// this will remove certain preferences in the case where user turned off crash recovery in the browser and browser is not restarting
	_handle_crash: function sm_handle_crash()
	{
		let sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
		// This will only be set to true, if crash recovery is turned off and browser is not restarting
		let no_remove = (sessionStartup && sessionStartup.sessionType && (sessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION)) ||
		                 gPreferenceManager.get("browser.sessionstore.resume_session_once", false, true) || 
		                 gPreferenceManager.get("browser.sessionstore.resume_from_crash", false, true);

		//dump("no_remove = " + resuming + "\n");
		//log("SessionManagerHelperComponent:handle_crash: no_remove = " + resuming, "DATA");
		// Unless browser is restarting, always delete the following preferences if crash recovery is disabled in case the browser crashes
		// otherwise bad things can happen
		if (!no_remove)
		{
			//dump("SessionManager: Removing preferences\n");
			gPreferenceManager.delete("_autosave_values");
		}
	},
	
	// This will check to see if there was a crash and if so put up the crash prompt 
	// to allow the user to choose a session to restore.  This is only called for Firefox 3.5 and up and SeaMonkey 2.0 and up
	_check_for_crash: function sm_check_for_crash(aStateDataString)
	{
		let initialState;
		try {
			// parse the session state into JS objects
			initialState = gSessionManager.JSON_decode(aStateDataString.QueryInterface(Ci.nsISupportsString).data);
		}
		catch (ex) { 
			logError(ex);
			return;
		} 
    
		let lastSessionCrashed =
			initialState && initialState.session && initialState.session.state &&
			initialState.session.state == "running";
		
		//log("SessionManagerHelperComponent:_check_for_crash: Last Crashed = " + lastSessionCrashed, "DATA");
		if (lastSessionCrashed) {
        	let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
        	// default to recovering
        	params.SetInt(0, 0);
        	Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher).
        		openWindow(null, "chrome://sessionmanager/content/restore_prompt.xul", "_blank", "chrome,modal,centerscreen,titlebar", params);
        	if (params.GetInt(0) == 1) aStateDataString.QueryInterface(Ci.nsISupportsString).data = "";
        	else if (initialState.session) {
				// if not using built-in crash prompt, make sure it doesn't prompt for tabs
				if (!gPreferenceManager.get("use_browser_crash_prompt", false)) {
					// don't prompt for tabs if checkbox not checked
					delete(initialState.session.lastUpdate);
					delete(initialState.session.recentCrashes);
					aStateDataString.QueryInterface(Ci.nsISupportsString).data = gSessionManager.JSON_encode(initialState);
				}
        	}
    	}
    	initialState = null;
	},

	// code adapted from Danil Ivanov's "Cache Fixer" extension
	_restoreCache: function sm_restoreCache()
	{
    	let cache = null;
		try 
		{
			let disabled = gPreferenceManager.get("disable_cache_fixer");
			if (disabled)
			{
				let consoleService = Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService);
  				consoleService.logStringMessage("SessionManager: Cache Fixer disabled");
				return;
			}
			let pd_path = gPreferenceManager.get("browser.cache.disk.parent_directory", null, true);
			if (pd_path) {
				cache = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
				cache.initWithPath(pd_path);
			}
		}
		catch (ex) { 
			cache = null; 
		}
		
		if (!cache) cache = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfLD", Ci.nsIFile);
		cache.append("Cache");
		cache.append("_CACHE_MAP_");
		if (!cache.exists())
		{
			return;
		}
		
		let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
		stream.init(cache, 0x01, 0, 0); // PR_RDONLY
		let input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
		input.setInputStream(stream);
		let content = input.readByteArray(input.available());
		input.close();
		
		if (content[15] != 1)
		{
			return;
		}
		content[15] = 0;
		
		stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		stream.init(cache, 0x02 | 0x20, 0600, 0); // PR_WRONLY | PR_TRUNCATE
		let output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
		output.setOutputStream(stream);
		output.writeByteArray(content, content.length);
		output.flush();
		output.close();
	},

	// Make sure that the browser and Session Manager are on the same page with regards to the startup preferences
	_synchStartup: function sm_synchStartup()
	{
		let browser_startup = gPreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true);

		// Ignore any preference changes made in this function
		this._ignorePrefChange = true;
		
		// If browser handling startup, disable Session Manager startup and backup startup page
		// otherwise set Session Manager to handle startup and restore browser startup setting
		if (browser_startup > STARTUP_PROMPT) {
			gPreferenceManager.set(SM_STARTUP_PREFERENCE, 0);
			gPreferenceManager.set(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, browser_startup);
		}
		else {
			gPreferenceManager.set(SM_STARTUP_PREFERENCE, (browser_startup == STARTUP_PROMPT) ? 1 : 2);
			gPreferenceManager.set(BROWSER_STARTUP_PAGE_PREFERENCE, gPreferenceManager.get(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, 1), true);
		}

		// Resume listening to preference changes
		this._ignorePrefChange = false;
	},
	
	handlePrivacyChange: function sm_handlePrivacyChange(aSubject, aData)
	{
		switch(aData) {
		case "enter":
			try {
				let ss = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
				gSessionManager.mBackupState = ss.getService(Ci.nsISessionStore).getBrowserState();
				gSessionManager.mAutoPrivacy = Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).autoStarted;
				log("SessionManagerHelperComponent: observer autoStarted = " + gSessionManager.mAutoPrivacy);
			}
			catch(ex) { 
				logError(ex);
			}
			
			// Only save if entering private browsing mode manually (i.e. not automatically on browser startup)
			// Use the mTimer variable since it isn't set until final-ui-startup.
			if (this.mTimer) {
				// Close current autosave session or make an autosave backup (if not already in private browsing mode)
				if (!gSessionManager.closeSession(false,true) && gSessionManager.mPref_autosave_session) {
					// If autostart or disabling history via options, make a real backup, otherwise make a temporary backup
					if (gSessionManager.isAutoStartPrivateBrowserMode()) {
						gSessionManager.backupCurrentSession(true);
					}
					else {
						gSessionManager.autoSaveCurrentSession(true); 
					}
				}
			}
			
			break;
		case "exit":
			// If browser not shutting down, clear the backup state otherwise set mShutDownInPrivateBrowsingMode flag
			aSubject.QueryInterface(Ci.nsISupportsPRBool);
			if (aSubject.data) {
				if (!gSessionManager.mPref_enable_saving_in_private_browsing_mode || !gSessionManager.mPref_encrypt_sessions) {
					gSessionManager.mShutDownInPrivateBrowsingMode = true;
					log("SessionManagerHelperComponent: observer mShutDownInPrivateBrowsingMode = " + gSessionManager.mShutDownInPrivateBrowsingMode, "DATA");
				}
			}
			else {
				gSessionManager.mBackupState = null;
			}
			break;
		}
	},
	
	handleQuitApplicationRequest: function(aSubject, aTopic, aData)
	{
		// If quit already canceled, just return
		if (aSubject.QueryInterface(Ci.nsISupportsPRBool) && aSubject.data) return;
		
		let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		
		// If encryption change in progress, prevent quit
		if (this._encryption_in_progress && (aTopic == "quit-application-requested")) {
			this._tried_to_quit = true;
			gSessionManager.threadSafeAlert(bundle.GetStringFromName("quit_during_encrypt_change_alert"));
			aSubject.QueryInterface(Ci.nsISupportsPRBool);
			aSubject.data = true;
			return;
		}

		// If private browsing mode don't allow saving
		try {
			if (Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).privateBrowsingEnabled) return;
		} catch(ex) {}
		
		let backup = gPreferenceManager.get(SM_BACKUP_SESSION_PREFERENCE);
		let resume_current = (gPreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true) == 3) || gPreferenceManager.get("browser.sessionstore.resume_session_once", false, true);

		// If not restarting and set to prompt, disable FF's quit prompt
		if ((aData != "restart") && (backup == 2)) {
			let window = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator).getMostRecentWindow("navigator:browser");
			if ((backup == 2) && ((aTopic == "quit-application-requested") || gPreferenceManager.get(SM_SHUTDOWN_ON_LAST_WINDOW_CLOSED_PREFERENCE))) {

				// Do session prompt here and then save the info in an Application Storage variable for use in
				// the shutdown procsesing in sessionmanager.js
				let watcher = Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher);
				// if didn't already shut down
				log("SessionManagerHelperComponent gSessionManager.mAlreadyShutdown = " + gSessionManager.mAlreadyShutdown, "DATA");
				if (!gSessionManager.mAlreadyShutdown) {

					// shared variables
					let params = null;
					let newtype = false;
					
					// Firefox 3.6 and earlier
					if (VERSION_COMPARE_SERVICE.compare(Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).platformVersion,"2.0a1pre") < 0) {

						// Manually construct the prompt window because the promptService doesn't allow 4 button prompts
						params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
						params.SetInt(0, 1); 												// Set default to cancel
						params.SetString(0, bundle.GetStringFromName("preserve_session"));	// dialog text
						params.SetString(1, bundle.GetStringFromName("prompt_not_again"));	// checkbox text
						params.SetString(12, bundle.GetStringFromName("sessionManager"));	// title
						
						// buttons are tricky because they don't display in order
						// if there are 4 buttons they display as 11, 8, 10, 9
						// if there are 3 buttons they display as 8, 10, 9
						// A button always returns it's string number - 8, eg: 10 returns 2.
						// So we need to tweak things when displaying 3 or 4 buttons.
						
						if (resume_current) {
							params.SetInt(2, 3);												// Display 3 buttons
							params.SetString(8, bundle.GetStringFromName("save_quit"));			// first button text (returns 0)
							params.SetString(10, bundle.GetStringFromName("quit"));				// second button text (returns 2)
							params.SetString(9, bundle.GetStringFromName("cancel"));			// third button text (returns 1)
						}
						else {
							params.SetInt(2, 4);												// Display 4 buttons
							params.SetString(11, bundle.GetStringFromName("save_quit"));		// first button text (returns 3)
							params.SetString(8, bundle.GetStringFromName("quit"));				// second button text (returns 0)
							params.SetString(10, bundle.GetStringFromName("save_and_restore"));	// third button text (returns 2)
							params.SetString(9, bundle.GetStringFromName("cancel"));			// fourth button text (returns 1)
						}
					}
					else {
						// New type of prompt in Firefox 4.0 - See http://mxr.mozilla.org/mozilla2.0/source/toolkit/components/prompts/src/nsPrompter.js
						newtype = true;
						
						params = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2).QueryInterface(Ci.nsIWritablePropertyBag);
						params.setProperty("promptType", "confirmEx");
						params.setProperty("title",      bundle.GetStringFromName("sessionManager"));
						params.setProperty("text",       bundle.GetStringFromName("preserve_session"));
						params.setProperty("checkLabel", bundle.GetStringFromName("prompt_not_again"));
						params.setProperty("checked",    false);

						if (resume_current) {
							params.setProperty("button0Label", bundle.GetStringFromName("save_quit"));			// 1st button (returns 0)
							params.setProperty("button2Label", bundle.GetStringFromName("quit"));				// 2nd button (returns 2)
							params.setProperty("button1Label", bundle.GetStringFromName("cancel"));				// 3rd button (returns 1)
						}
						else {
							params.setProperty("button3Label", bundle.GetStringFromName("save_quit"));			// 1st button (returns 3)
							params.setProperty("button0Label", bundle.GetStringFromName("quit"));				// 2nd button (returns 0)
							params.setProperty("button2Label", bundle.GetStringFromName("save_and_restore"));	// 3rd button (returns 2)
							params.setProperty("button1Label", bundle.GetStringFromName("cancel")); 			// 4th button (returns 1);
						}
					}
					
					watcher.openWindow(window, "chrome://global/content/commonDialog.xul", "_blank", "centerscreen,chrome,modal,titlebar", params);
					let results = newtype ? params.getProperty("buttonNumClicked") : params.GetInt(0);
					let checkbox_checked = newtype ? params.getProperty("checked") : params.GetInt(1);
						
					// If cancel pressed, cancel shutdown and return;
					if (results == 1) {
						aSubject.QueryInterface(Ci.nsISupportsPRBool);
						aSubject.data = true;
						return;
					}
					
					// At this point the results value doesn't match what the
					// backupCurrentSession function in sessionmanager.js expects which is
					// the Save & Quit to be 0, Quit to be 1 and Save & Restore to be 2, so tweak the values here.
					switch (results) {
						// Save & Quit when four buttons displayed
						case 3:
							results = 0;
							break;
						// Quit (4 buttons) or Save & Quit (3 buttons)
						case 0:
							results = resume_current ? 0 : 1;
							break;
						case 2:
							results = resume_current ? 1 : 2;
					}
					
					// If checkbox checked
					if (checkbox_checked)
					{
						if (results == 2) {
							gPreferenceManager.set(SM_RESUME_SESSION_PREFERENCE, BACKUP_SESSION_FILENAME);
							gPreferenceManager.set(SM_STARTUP_PREFERENCE, 2)
						}
						gPreferenceManager.set(SM_BACKUP_SESSION_PREFERENCE, (results == 1)?0:1);
					}
							
					gSessionManager.mShutdownPromptResults = results;
					
					// Disable prompt in browser
					let prefValue = gPreferenceManager.get(BROWSER_WARN_ON_QUIT, null, true);
					if (typeof(prefValue) == "boolean") {
						if (typeof(this._warnOnQuit) != "boolean") {
							this._warnOnQuit = prefValue;
						}
						gPreferenceManager.set(BROWSER_WARN_ON_QUIT, false, true);
					}
					// Disable prompt in tab mix plus if it's running
					prefValue = gPreferenceManager.get(BROWSER_TABS_WARN_ON_CLOSE, null, true);
					if (typeof(prefValue) == "boolean") {
						if (typeof(this._warnOnClose) != "boolean") {
							this._warnOnClose = prefValue;
						}
						gPreferenceManager.set(BROWSER_TABS_WARN_ON_CLOSE, false, true);
					}
					prefValue = gPreferenceManager.get(TMP_PROTECTED_TABS_WARN_ON_CLOSE, null, true);
					if (typeof(prefValue) == "boolean") {
						if (typeof(this._TMP_protectedtabs_warnOnClose) != "boolean") {
							this._TMP_protectedtabs_warnOnClose = prefValue;
						}
						gPreferenceManager.set(TMP_PROTECTED_TABS_WARN_ON_CLOSE, false, true);
					}
				}
			}
		}
	}
};

// Register Component
/**
* XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
* XPCOMUtils.generateNSGetModule is for Mozilla 1.9.2 (Firefox 3.6).
*/
if (XPCOMUtils.generateNSGetFactory)
    var NSGetFactory = XPCOMUtils.generateNSGetFactory([SessionManagerHelperComponent]);
else
    var NSGetModule = XPCOMUtils.generateNSGetModule([SessionManagerHelperComponent]);