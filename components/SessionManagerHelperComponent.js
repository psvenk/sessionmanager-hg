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
const global_scope = this;

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

const HIGHEST_STARTUP_PROCESSING_VALUE = 4;
const IDLE_TIME = 60; // How many seconds to wait before system is considered idle.
const PERIODIC_TIME = 86400000;  // Do background processing every 24 hours (when idle)
const PROCESS_AT_STARTUP = false;  // Process background processing immediately upon startup if true, otherwise wait till system is idle or time below
const STARTUP_TIMER = 900000; // Time (15 minutes) to wait for system to go idle before forcing background processing to start

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// Session Manager's helper component.  It handles the following:
// 1. Searching command line arguments for sessions to load
// 2. Clearing autosave preference on a crash if crash recovery is disabled
// 3. Putting up the crash prompt in Firefox 3.5+ and SeaMonkey 2.0+
// 4. Handle saving session data when entering private browsing mode.
// 5. Kick off the initial window restored processing when SessionStore restores all windows at startup
// 6. Force saving of the preference file upon notification
// 7. Handles syncing the Firefox and Session Manager startup preferences.  
// 8. Handles saving and restoring browser startup preference at startup and shutdown (if need be).
// 9. Handles displaying the Session Manager shut down prompt and overriding the browser and Tab Mix Plus's prompts.
// 10. Prevent shutdown when encryption change is in progress
// 11. Check for when initial window load is complete at startup to kick off saving crashed windows (if needed) and caching sessions.
//
function SessionManagerHelperComponent() {
	try {
		Cu.import("resource://sessionmanager/modules/logger.jsm");
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
	_xpcom_categories: [{ category: "profile-after-change"},
	                    { category: "command-line-handler", entry: "SessionManagerHelperComponent" }],
						
	// State variables
	_encryption_in_progress: false,
	_encryption_in_progress_system_idle: false,
	_encryption_stopped_because_system_no_longer_idle: false,
	_ignorePrefChange: false,
	_last_processing_time: 0, 
	_no_master_password_check: false,
	_processing_while_idle: false,
	_sessionStore_windows_restored: -1,
	_sessionManager_windows_restored: -1,
	_sessionManager_windows_loaded: 0,
	_startup_process_state: 0,
	_startup_timer_processing: false,
	_system_idle: false, 
	_TMP_protectedtabs_warnOnClose: null,
	_warnOnQuit: null,
	_warnOnClose: null,
	
	// Timers
	mTimer: null,
	mStartupTimer: null,
	
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
		case "private-browsing-change-granted":
			this.handlePrivacyChange(aSubject, aData);
			break;
		case "profile-after-change":
			Cu.import("resource://sessionmanager/modules/preference_manager.jsm");
			Cu.import("resource://sessionmanager/modules/session_manager.jsm");
			// Register for other notifications
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
			os.addObserver(this, "sessionstore-windows-restored", false);
			os.addObserver(this, "profile-change-teardown", false);
			os.addObserver(this, "private-browsing-change-granted", false);
			os.addObserver(this, "sessionmanager:windows-restored", false);
			os.addObserver(this, "sessionstore-browser-state-restored", false);
			os.addObserver(this, "sessionmanager:window-loaded", false);
			os.addObserver(this, "sessionmanager:startup-process-finished", false);
		
			try
			{
				// Call the gPreferenceManager Module's initialize procedure
				gPreferenceManager.initialize();
				
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
			
			// use lazy modules if available (Gecko 2.0 and up)
			if (XPCOMUtils.defineLazyModuleGetter) {
				XPCOMUtils.defineLazyModuleGetter(global_scope, "PasswordManager", "resource://sessionmanager/modules/password_manager.jsm");
			}
			else {
				Cu.import("resource://sessionmanager/modules/password_manager.jsm");
			}
			
			// Startup backup timer (if applicable)
			gSessionManager.checkBackupTimer();
			
			// Observe startup preference
			gPreferenceManager.observe(BROWSER_STARTUP_PAGE_PREFERENCE, this, false, true);
			break;
		case "sessionmanager:encryption-change":
			var data = aData.split(" ");
			this._encryption_in_progress = (data[0] == "start");
			if (this._encryption_in_progress) {
				if (typeof gEncryptionManager == "undefined")
					Cu.import("resource://sessionmanager/modules/encryption_manager.jsm");
				gEncryptionManager.changeEncryption(data[1]);
			}
			
			// Set idle encryption flag, if system currently idle and starting encrypting, clear it otherwise
			this._encryption_in_progress_system_idle = this._encryption_in_progress && this._system_idle;
			
			// update SQL cache when encryption is done or if startup processing was interupted resume it
			if (!this._encryption_in_progress && !this._encryption_stopped_because_system_no_longer_idle) {
				if (this._startup_process_state < HIGHEST_STARTUP_PROCESSING_VALUE)
					this._process_next_async_periodic_function();
				else
					gSQLManager.changeEncryptionSQLCache();
			}
			break;
		case "sessionmanager:window-loaded":
			// When Session Manager has finished processing the "onLoad" event for the same number of windows that
			// SessionStore reported was restored, then tell all the browser widnows that the initial session has been restored.
			this._sessionManager_windows_loaded = this._sessionManager_windows_loaded + 1;
			this._check_for_window_restore_complete();
			break;
		case "sessionstore-browser-state-restored":
			// Just log this for now to see if we can use it for anything, it gets sent after all browser windows
			// are restored when calling setBrowserState or when using restore last session item under history menu.  
			// It does not get called when restoring individual windows (setWindowState) or at browser startup.
			break;
		case "sessionstore-windows-restored":
			// Currently this is only called once per browsing session.  Don't unregister it in case
			// user runs on a Mac where closing all windows ends browsing session, but doesn't exit browser.
			//os.removeObserver(this, aTopic);
			
			// only process if Session Manager isn't loading crashed or backup session
			if (!gSessionManager._crash_session_filename && !gSessionManager._restoring_backup_session && !gSessionManager._restoring_autosave_backup_session)
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
			this._sessionManager_windows_restored = aData;
			this._check_for_window_restore_complete();
			break;
		case "sessionmanager:startup-process-finished":
			// If processing kicked off because system was idle and no longer idle, don't do anything
			if (this._system_idle || !this._processing_while_idle) {
				// Don't let idle processing happen at the same time that the startup timer processing happens.
				if (aData == "startup_timer")
					this._startup_timer_processing = true;
			
				// If encryption change detected while caching sessions, handle encryption processing first
				// then resume caching.
				if ((aData == "encryption_change_detected") && !this._no_master_password_check) {
					if (PasswordManager.enterMasterPassword()) {
						this._processing_while_idle = false;
						var folder = (this._startup_process_state == 3) ? gSessionManager._string("deleted_sessions_folder") : "";
						OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:encryption-change", "start " + folder);
					}
					else {
						gSessionManager.cryptError(gSessionManager._string("encryption_processing_failure"));
						this._no_master_password_check = true;
						this._process_next_async_periodic_function();
					}
				}
				else
					this._process_next_async_periodic_function();
			}
			else {
				// Since callback indicated there was an encryption change, make sure we do encryption processing on next idle
				this._encryption_stopped_because_system_no_longer_idle = (aData == "encryption_change_detected");
				this._processing_while_idle = false;
			}
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
			os.removeObserver(this, "sessionmanager:startup-process-finished");
			os.removeObserver(this, "sessionmanager:windows-restored");
			os.removeObserver(this, "sessionstore-browser-state-restored");
			os.removeObserver(this, "sessionmanager:encryption-change");
			os.removeObserver(this, "sessionmanager-preference-save");
			os.removeObserver(this, "sessionmanager:ignore-preference-changes");
			os.removeObserver(this, "quit-application-requested");
			os.removeObserver(this, "browser-lastwindow-close-requested");
			os.removeObserver(this, "browser-lastwindow-close-granted");
			os.removeObserver(this, aTopic);
			
			// Remove preference observer
			gPreferenceManager.unobserve(BROWSER_STARTUP_PAGE_PREFERENCE, this, true);
			
			// If encryption change is in progress, stop it.
			if (this._encryption_in_progress) {
				gEncryptionManager.stop();
			}
			
			// Remove watch for when system is idle
			var idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService);
			idleService.removeIdleObserver(this, IDLE_TIME);
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
		case "idle":
			// Called when system is idle
			this._system_idle = true;
			this._do_idle_processing();
			break;
		case "back":
			// Called when system is no longer idle
			this._system_idle = false;
			// If encryption change is in progress and it was kicked off when system was idle, stop it.
			if (this._encryption_in_progress_system_idle) {
				this._encryption_stopped_because_system_no_longer_idle = true;
				gEncryptionManager.stop();
			}
			break;
		}
	},

	/* ........ private methods .............. */
	
	// This will send out notifications to Session Manager windows when the number of loaded windows equals the number of
	// restored windows.  If SessionStore is restoring the windows or no windows are being restored, this happens once.
	// If Session Manager is restoring a backup or crash file, it will trigger twice, only do the notification part the second time.
	_check_for_window_restore_complete: function sm_check_for_window_restore_complete()
	{
		log("_check_for_window_restore_complete: SessionStore windows restored = " + this._sessionStore_windows_restored + 
		    ", Session Manager windows restored = " + this._sessionManager_windows_restored + ", SessionManager windows loaded = " + this._sessionManager_windows_loaded, "DATA");

		let sessionstore_restored = (this._sessionManager_windows_loaded == this._sessionStore_windows_restored);
		let sessionmanager_restored = (this._sessionManager_windows_loaded == this._sessionManager_windows_restored);
		if (sessionstore_restored || sessionmanager_restored) {
			// Stop counting loaded windows and reset count
			gSessionManager._countWindows = false;
			this._sessionManager_windows_loaded = 0;
			if (sessionstore_restored)
				this._sessionStore_windows_restored = -1;
			if (sessionmanager_restored)
				this._sessionManager_windows_restored = -1;
			Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService).notifyObservers(null, "sessionmanager:initial-windows-restored", null); 
			
			// Save window sessions from crashed session in the background if necessary and not in private browsing mode
			if (gSessionManager._save_crashed_autosave_windows && gSessionManager._crash_backup_session_file && !gSessionManager.isPrivateBrowserMode()) {
				let window = gSessionManager.getMostRecentWindow();
				if (window) {
					gSessionManager._screen_width = window.screen.width;
					gSessionManager._screen_height = window.screen.height;
				}
			
				// Save crashed windows
				gSessionManager.saveCrashedWindowSessions();
				gSessionManager._screen_width = null;
				gSessionManager._screen_height = null;
				// Don't save again if this is called again
				gSessionManager._save_crashed_autosave_windows = false;
				log("SessionManagerHelperComponent _check_for_window_restore_complete: Open Window Sessions at time of crash saved.", "TRACE");
			}

			// Add watch for when system is idle for at least a minute
			var idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService);
			idleService.addIdleObserver(this, IDLE_TIME);
			
			// Kick off startup processing or start timer to run processing (depending on flag), only done once per run
			if (!this._startup_process_state && PROCESS_AT_STARTUP)
				// process next function
				this._process_next_async_periodic_function();
			else {
				// Start a timer to force running of background processing after 15 minutes if system never goes idle
				this.mStartupTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				this.mStartupTimer.initWithCallback({
					notify:function (aTimer) { OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:startup-process-finished", "startup_timer"); }
				}, STARTUP_TIMER, Ci.nsITimer.TYPE_ONE_SHOT);
			}
			
		}
	},
	
	_do_idle_processing: function() {
			// Cancel startup timer if it hasn't already fired
			if (this.mStartupTimer) {
				this.mStartupTimer.cancel();
				this.mStartupTimer = null
			}
			
			// if Startup timer expired and is currently processing exit
			if (this._startup_timer_processing)
				return;
	
			// Don't do anything if encryption change already in progress or already doing periodic processing
			if (this._encryption_in_progress || this._processing_while_idle)
				return;
				
			let time = Date.now();
			let do_encryption_change = this._encryption_stopped_because_system_no_longer_idle;
			this._encryption_stopped_because_system_no_longer_idle = false;
			// If there was an encryption change detected and we never finished processing it, then continue encryption change processing.
			// Otherwise continue the periodic processing if in the middle or it or haven't run periodic processing in 24 hours.
			if (do_encryption_change)
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:encryption-change", "start");
			else if ((this._startup_process_state < HIGHEST_STARTUP_PROCESSING_VALUE) || (this._last_processing_time + PERIODIC_TIME < time)) {
				if ((this._last_processing_time + PERIODIC_TIME < time) && (this._startup_process_state >= HIGHEST_STARTUP_PROCESSING_VALUE))
					this._startup_process_state = 0;
				this._processing_while_idle = true;
				this._process_next_async_periodic_function();
			}
	},
	
	// This handles startup procesing, but stages it so it doesn't all happen at once.
	_process_next_async_periodic_function: function() {
		this._startup_process_state++;
		log("Startup processing = " + this._startup_process_state, "TRACE");
		switch(this._startup_process_state) {
		case 1:
			// remove old deleted sessions
			gSessionManager.purgeOldDeletedSessions(true);
			var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			timer.initWithCallback({
				notify:function (aTimer) { OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:startup-process-finished", null); }
			}, 0, Ci.nsITimer.TYPE_ONE_SHOT);
			break;
		case 2:
			// Cache sessions
			gSessionManager.cacheSessions();
			break;
		case 3:
			// Cache deleted sessions
			gSessionManager.cacheSessions(gSessionManager._string("deleted_sessions_folder"));
			break;
		case 4:
			// If using SQL cache and not yet created, populate SQL cache otherwise check cache.  If not using it delete it.
			if (gSessionManager.mPref["use_SQLite_cache"]) {
				if (!gSQLManager.updateSQLCache(false, true));
					gSQLManager.checkSQLCache();
			}
			else {
				gSQLManager.removeSessionFromSQLCache();
			}
			this._no_master_password_check = false;
			this._processing_while_idle = false;
			this._startup_timer_processing = false;
			this._last_processing_time = Date.now();
			break;
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
				// backup the current browser state and privacy auto-start setting
				let ss = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
				gSessionManager.mBackupState = ss.getService(Ci.nsISessionStore).getBrowserState();
				gSessionManager.mAutoPrivacy = Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).autoStarted;
				log("SessionManagerHelperComponent: observer autoStarted = " + gSessionManager.mAutoPrivacy, "DATA");
				
				// Save off current autosave data
				gSessionManager._pb_saved_autosave_values = gPreferenceManager.get("_autosave_values", null);
			}
			catch(ex) { 
				logError(ex);
			}
			
			// Only save if entering private browsing mode manually (i.e. not automatically on browser startup)
			// Use the mTimer variable since it isn't set until final-ui-startup.
			if (this.mTimer) {
				// Close current autosave session or make an autosave backup (if not already in private browsing mode)
				if (!gSessionManager.closeSession(false,true)) {
					// If autostart or disabling history via options, make a real backup, otherwise make a temporary backup
					if (gSessionManager.isAutoStartPrivateBrowserMode()) {
						gSessionManager.backupCurrentSession(true);
					}
					else if (gSessionManager.mPref["autosave_session"]) {
						gSessionManager.autoSaveCurrentSession(true); 
					}
				}
				// Close all open window sessions and force them to save despite being "in" private browsing.
				gSessionManager.mAboutToEnterPrivateBrowsing = true;
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = false;
				OBSERVER_SERVICE.notifyObservers(abandonBool, "sessionmanager:close-windowsession", null);
				gSessionManager.mAboutToEnterPrivateBrowsing = false;
			}
			
			break;
		case "exit":
			// If browser not shutting down (aSubject.data not set to true), clear the backup state otherwise set mShutDownInPrivateBrowsingMode flag
			aSubject.QueryInterface(Ci.nsISupportsPRBool);
			if (aSubject.data) {
				gSessionManager.mShutDownInPrivateBrowsingMode = true;
				log("SessionManagerHelperComponent: observer mShutDownInPrivateBrowsingMode = " + gSessionManager.mShutDownInPrivateBrowsingMode, "DATA");
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
		
		// If private browsing mode don't allow saving
		try {
			if (Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).privateBrowsingEnabled) return;
		} catch(ex) {}
		
		let backup = gPreferenceManager.get(SM_BACKUP_SESSION_PREFERENCE);
		// Resuming current if restarting, Firefox is set to restore last session or Session Manager is set to resume last session.  If Session Manager
		// is resuming current, display "quit and restore" instead of "quit and save" since that's what it does.
		let resume_current = gPreferenceManager.get("browser.sessionstore.resume_session_once", false, true) ||
		                     ((gPreferenceManager.get(SM_STARTUP_PREFERENCE) == 0) && (gPreferenceManager.get(BROWSER_STARTUP_PAGE_PREFERENCE, 1, true) == 3));
		let resume_current_sm = ((gPreferenceManager.get(SM_STARTUP_PREFERENCE) == 2) && (gPreferenceManager.get(SM_RESUME_SESSION_PREFERENCE) == BACKUP_SESSION_FILENAME));

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
						
						if (resume_current || resume_current_sm) {
							params.SetInt(2, 3);												// Display 3 buttons
							// If browser is resuming, display save and quit.  If Session Manager is resuming display save and restore.
							if (resume_current)
								params.SetString(8, bundle.GetStringFromName("save_quit"));			// first button text (returns 0)
							else
								params.SetString(8, bundle.GetStringFromName("save_and_restore"));	// first button text (returns 0)
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

						if (resume_current || resume_current_sm) {
							// If browser is resuming, display save and quit.  If Session Manager is resuming display save and restore.
							if (resume_current)
								params.setProperty("button0Label", bundle.GetStringFromName("save_quit"));			// 1st button (returns 0)
							else
								params.setProperty("button0Label", bundle.GetStringFromName("save_and_restore"));	// 1st button (returns 0)
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
							results = (resume_current || resume_current_sm) ? 0 : 1;
							break;
						case 2:
							results = (resume_current || resume_current_sm) ? 1 : 2;
					}
					
					// If checkbox checked
					if (checkbox_checked)
					{
						switch (results) {
							case 2:  // Save & Restore
								gPreferenceManager.set(SM_RESUME_SESSION_PREFERENCE, BACKUP_SESSION_FILENAME);
								gPreferenceManager.set(SM_STARTUP_PREFERENCE, 2);
								break;
							case 1: // Quit
								// If currently resuming previous session, don't
								if (resume_current_sm)
									gPreferenceManager.set(SM_STARTUP_PREFERENCE, 0);
								break;
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