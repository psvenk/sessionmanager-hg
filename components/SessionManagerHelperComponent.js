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

const Application = Cc["@mozilla.org/fuel/application;1"] ? Cc["@mozilla.org/fuel/application;1"].getService(Ci.fuelIApplication) :  
                    (Cc["@mozilla.org/smile/application;1"] ? Cc["@mozilla.org/smile/application;1"].getService(Ci.smileIApplication) : null);

const BROWSER_STARTUP_PAGE_PREFERENCE = "browser.startup.page";

// Session Manager files
const SM_BACKUP_FILE = "backup.session";

// Session Manager preferences
const OLD_BROWSER_STARTUP_PAGE_PREFERENCE = "extensions.sessionmanager.old_startup_page";
const SM_ALLOW_SAVE_IN_PBM_PREFERENCE = "extensions.sessionmanager.enable_saving_in_private_browsing_mode";
const SM_BACKUP_SESSION_PREFERENCE = "extensions.sessionmanager.backup_session";
const SM_ENCRYPT_SESSIONS_PREFERENCE = "extensions.sessionmanager.encrypt_sessions";
const SM_RESUME_SESSION_PREFERENCE = "extensions.sessionmanager.resume_session";
const SM_STARTUP_PREFERENCE = "extensions.sessionmanager.startup";
const SM_SHUTDOWN_ON_LAST_WINDOW_CLOSED_PREFERENCE = "extensions.sessionmanager.shutdown_on_last_window_close";

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// Thread variables/constants
const main = Cc["@mozilla.org/thread-manager;1"].getService(Ci.nsIThreadManager).currentThread;
var sessionLoadThread = null;

// Main Thread called when finished loading sessions
var mainThread = {
	run: function() {
		try {
			sessionLoadThread.shutdown();
			delete(sessionLoadThread);
			log("SessionManagerHelperComponent mainThread: Background Session Thread destroyed from mainThread", "TRACE");
		} catch(err) {
			logError(err);
		}
	},
  
	QueryInterface: function(iid) {
		if (iid.equals(Ci.nsIRunnable) || iid.equals(Ci.nsISupports)) {
			return this;
		}
		throw Cr.NS_ERROR_NO_INTERFACE;
	}
};

// A thread used to load the session files in the background so they will 
// be cached when the user goes to use them.
var backgroundThread = {
	run: function() {
		//perform work here that doesn't touch the DOM or anything else that isn't thread safe
		try {
			gSessionManager.getSessions();
			log("SessionManagerHelperComponent backgroundThread: Background Session Load Complete", "TRACE");
		} catch(err) {
			logError(err);
		}
		// kick off current thread to terminate this thread
		main.dispatch(mainThread, main.DISPATCH_NORMAL);
	},
  
	QueryInterface: function(iid) {
		if (iid.equals(Ci.nsIRunnable) || iid.equals(Ci.nsISupports)) {
			return this;
		}
		throw Cr.NS_ERROR_NO_INTERFACE;
	}
};

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
//
function SessionManagerHelperComponent() {
	try {
		Cu.import("resource://sessionmanager/modules/logger.jsm");
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
	_xpcom_categories: [{ category: "app-startup", service: true },
	                    { category: "command-line-handler", entry: "sessionmanager" }],
						
	// State variables
	_ignorePrefChange: false,
	_warnOnQuit: null,
	_warnOnClose: null,
	_TMP_protectedtabs_warnOnClose: null,
	
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
		let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		
		//dump(aTopic + "\n");
		log("SessionManagerHelperComponent observer: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "app-startup":
			os.addObserver(this, "profile-after-change", false);
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
			os.addObserver(this, "sessionstore-windows-restored", false);
			os.addObserver(this, "profile-change-teardown", false);
			os.addObserver(this, "private-browsing-change-granted", false);
			break;
		case "private-browsing-change-granted":
			this.handlePrivacyChange(aSubject, aData);
			break;
		case "profile-after-change":
			os.removeObserver(this, aTopic);
			try
			{
				this._restoreCache();
				
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
			// The following two notifications occur when the last browser window closes, but the application isn't actually quitting.
			os.addObserver(this, "browser-lastwindow-close-requested", false);
			os.addObserver(this, "browser-lastwindow-close-granted", false);
			os.addObserver(this, "sessionmanager-preference-save", false);
			os.addObserver(this, "sessionmanager:restore-startup-preference", false);
			os.addObserver(this, "sessionmanager:ignore-preference-changes", false);
			
			// Observe startup preference
			pb.addObserver(BROWSER_STARTUP_PAGE_PREFERENCE, this, false);
			
			// Cache the sessions in the background so they are ready when the user opens the menu
			// Don't do this in Firefox 3 since it will cause a hang or crash - See Firefox bug 466850 - https://bugzilla.mozilla.org/show_bug.cgi?id=466850
			if ((Application.id != "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}") || (Application.version > "3.1")) {
				sessionLoadThread = Cc["@mozilla.org/thread-manager;1"].getService().newThread(0);
				sessionLoadThread.dispatch(backgroundThread, sessionLoadThread.DISPATCH_NORMAL);
			}
			break;
		case "sessionstore-windows-restored":
			os.removeObserver(this, aTopic);
			try 
			{
				// Tell the browser windows that the initial session has been restored
				// Do this here so we don't have to add an observer to every window that opens which is
				// pointless since this only fires at browser startup. Delay a second to allow windows to load
				let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				timer.initWithCallback({
					notify:function (aTimer) { 
						Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService).notifyObservers(null, "sessionmanager:initial-windows-restored", null); 
					}
				}, 1000, Ci.nsITimer.TYPE_ONE_SHOT);
			}
			catch (ex) { logError(ex); }
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
				if (pb.prefHasUserValue(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
					pb.setIntPref(BROWSER_STARTUP_PAGE_PREFERENCE, pb.getIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE));
				}
				else {
					pb.setIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE));
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
			this.handleQuitApplicationRequest(aSubject, aTopic, aData, pb);
			break;
		case "browser-lastwindow-close-granted":
			if (typeof(this._warnOnQuit) == "boolean") {
				pb.setBoolPref("browser.warnOnQuit", this._warnOnQuit);
			}
			if (typeof(this._warnOnClose) == "boolean") {
				pb.setBoolPref("browser.tabs.warnOnClose", this._warnOnClose);
			}
			if (typeof(this._TMP_protectedtabs_warnOnClose) == "boolean") {
				pb.setBoolPref("extensions.tabmix.protectedtabs.warnOnClose", this._TMP_protectedtabs_warnOnClose);
			}
			break;
		case "quit-application-granted":
			if (typeof(this._warnOnQuit) == "boolean") {
				pb.setBoolPref("browser.warnOnQuit", this._warnOnQuit);
			}
			if (typeof(this._warnOnClose) == "boolean") {
				pb.setBoolPref("browser.tabs.warnOnClose", this._warnOnClose);
			}
			if (typeof(this._TMP_protectedtabs_warnOnClose) == "boolean") {
				pb.setBoolPref("extensions.tabmix.protectedtabs.warnOnClose", this._TMP_protectedtabs_warnOnClose);
			}
			os.removeObserver(this, "sessionmanager-preference-save");
			os.removeObserver(this, "sessionmanager:ignore-preference-changes");
			os.removeObserver(this, "quit-application-requested");
			os.removeObserver(this, "browser-lastwindow-close-requested");
			os.removeObserver(this, "browser-lastwindow-close-granted");
			os.removeObserver(this, aTopic);
			
			// Remove preference observer
			pb.removeObserver(BROWSER_STARTUP_PAGE_PREFERENCE, this);
			break;
		case "profile-change-teardown":
			let page = pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE);
			// If Session Manager is handling startup, save the current startup preference and then set it to home page
			// otherwise clear the saved startup preference
			if ((page == 3) && pb.getIntPref(SM_STARTUP_PREFERENCE)) {
				pb.setIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, page);
				pb.clearUserPref(BROWSER_STARTUP_PAGE_PREFERENCE);
			}
			else if (pb.prefHasUserValue(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
				pb.clearUserPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE);
			}
			pb.removeObserver(BROWSER_STARTUP_PAGE_PREFERENCE, this);
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

	// this will remove certain preferences in the case where user turned off crash recovery in the browser and browser is not restarting
	_handle_crash: function sm_handle_crash()
	{
		let prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		let sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
		// This will only be set to true, if crash recovery is turned off and browser is not restarting
		let no_remove = (sessionStartup && sessionStartup.sessionType && (sessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION)) ||
		                 prefroot.getBoolPref("browser.sessionstore.resume_session_once") || 
		                 prefroot.getBoolPref("browser.sessionstore.resume_from_crash");

		//dump("no_remove = " + resuming + "\n");
		//log("SessionManagerHelperComponent:handle_crash: no_remove = " + resuming, "DATA");
		// Unless browser is restarting, always delete the following preferences if crash recovery is disabled in case the browser crashes
		// otherwise bad things can happen
		if (!no_remove)
		{
			//dump("SessionManager: Removing preferences\n");
			prefroot.deleteBranch("extensions.sessionmanager._autosave_values");
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
	        	// don't prompt for tabs if checkbox not checked
	        	delete(initialState.session.lastUpdate);
	        	delete(initialState.session.recentCrashes);
	        	aStateDataString.QueryInterface(Ci.nsISupportsString).data = gSessionManager.JSON_encode(initialState);
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
			let prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			let disabled = prefroot.getBoolPref("extensions.sessionmanager.disable_cache_fixer");
			if (disabled)
			{
				let consoleService = Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService);
  				consoleService.logStringMessage("SessionManager: Cache Fixer disabled");
				return;
			}
			let pd_path = prefroot.getComplexValue("browser.cache.disk.parent_directory",Ci.nsISupportsString).data;
			cache = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
			cache.initWithPath(pd_path);
		}
		catch (ex) {}
		
		if (!cache) cache = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfLD", Ci.nsILocalFile);
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
		let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		let browser_startup = pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE);
		let sm_startup = pb.getIntPref(SM_STARTUP_PREFERENCE);
		//dump("page:" + browser_startup + ", startup:" + sm_startup + "\n");

		// Ignore any preference changes made in this function
		this._ignorePrefChange = true;
		
		// If browser handling startup, disable Session Manager startup and backup startup page
		// otherwise set Session Manager to handle startup and restore browser startup setting
		if (browser_startup > STARTUP_PROMPT) {
			pb.setIntPref(SM_STARTUP_PREFERENCE, 0);
			pb.setIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, browser_startup);
		}
		else {
			pb.setIntPref(SM_STARTUP_PREFERENCE, (browser_startup == STARTUP_PROMPT) ? 1 : 2);
			pb.setIntPref(BROWSER_STARTUP_PAGE_PREFERENCE, pb.getIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE));
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
	
	handleQuitApplicationRequest: function(aSubject, aTopic, aData, pb)
	{
		// If quit already canceled, just return
		if (aSubject.QueryInterface(Ci.nsISupportsPRBool) && aSubject.data) return;

		// If private browsing mode don't allow saving unless overridding
		try {
			let inPrivateBrowsing = Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).privateBrowsingEnabled;
			if (inPrivateBrowsing) {
				if (!pb.getBoolPref(SM_ALLOW_SAVE_IN_PBM_PREFERENCE) || !pb.getBoolPref(SM_ENCRYPT_SESSIONS_PREFERENCE)) {
					return;
				}
			}
		} catch(ex) {}
		
		let backup = pb.getIntPref(SM_BACKUP_SESSION_PREFERENCE);
		let resume_current = (pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE) == 3) || pb.getBoolPref("browser.sessionstore.resume_session_once");

		// If not restarting and set to prompt, disable FF's quit prompt
		if ((aData != "restart") && (backup == 2)) {
			let window = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator).getMostRecentWindow("navigator:browser");
			if ((backup == 2) && ((aTopic == "quit-application-requested") || pb.getBoolPref(SM_SHUTDOWN_ON_LAST_WINDOW_CLOSED_PREFERENCE))) {

				// Do session prompt here and then save the info in an Application Storage variable for use in
				// the shutdown procsesing in sessionmanager.js
				let watcher = Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher);
				// if didn't already shut down
				log("SessionManagerHelperComponent gSessionManager.mAlreadyShutdown = " + gSessionManager.mAlreadyShutdown, "DATA");
				if (!gSessionManager.mAlreadyShutdown) {
					let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");

					// Manually construct the prompt window because the promptService doesn't allow 4 button prompts
					let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
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
					
					watcher.openWindow(window, "chrome://global/content/commonDialog.xul", "_blank", "centerscreen,chrome,modal,titlebar", params);
					let results = params.GetInt(0);
						
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
					if (params.GetInt(1))
					{
						if (results == 2) {
							let str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
							str.data = SM_BACKUP_FILE;
							pb.setComplexValue(SM_RESUME_SESSION_PREFERENCE, Ci.nsISupportsString, str);
							pb.setIntPref(SM_STARTUP_PREFERENCE, 2)
						}
						pb.setIntPref(SM_BACKUP_SESSION_PREFERENCE, (results == 1)?0:1);
					}
							
					gSessionManager.mShutdownPromptResults = results;
					
					// Disable prompt in browser
					if (pb.getPrefType("browser.warnOnQuit") == pb.PREF_BOOL) {
						if (typeof(this._warnOnQuit) != "boolean") {
							this._warnOnQuit = pb.getBoolPref("browser.warnOnQuit");
						}
						pb.setBoolPref("browser.warnOnQuit", false);
					}
					// Disable prompt in tab mix plus if it's running
					if (pb.getPrefType("browser.tabs.warnOnClose") == pb.PREF_BOOL) {
						if (typeof(this._warnOnClose) != "boolean") {
							this._warnOnClose = pb.getBoolPref("browser.tabs.warnOnClose");
						}
						pb.setBoolPref("browser.tabs.warnOnClose", false);
					}
					if (pb.getPrefType("extensions.tabmix.protectedtabs.warnOnClose") == pb.PREF_BOOL) {
						if (typeof(this._TMP_protectedtabs_warnOnClose) != "boolean") {
							this._TMP_protectedtabs_warnOnClose = pb.getBoolPref("extensions.tabmix.protectedtabs.warnOnClose");
						}
						pb.setBoolPref("extensions.tabmix.protectedtabs.warnOnClose", false);
					}
				}
			}
		}
	}
};

// Register Component
function NSGetModule(compMgr, fileSpec) {
  return XPCOMUtils.generateModule([SessionManagerHelperComponent]);
};