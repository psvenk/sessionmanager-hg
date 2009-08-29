// To Do:
// 1. On crash if don't select to restore current session or select tabs, window sessions will be lost.  Should label window sessions as such in 
//    windows list and restore said sessions if don't select tabs for that window.  Might be tricky.
// 2. Add way of add window(s) to an existing session.
// 3. Add way of deleting window(s) from an existing session.
// 4. Add way of combining delete/load/save/etc into existing window prompt and letting user choose to perform functionality without
//    having the prompt window close. (Session Editor)
// 5. Add sub-grouping

var gSessionManager = {
	_timer : null,
	_win_timer : null,
	
	// Browser Components
	mObserverService: Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService),
	mPrefRoot: Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefBranch2),
	mWindowMediator: Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator),
	mPromptService: Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService),
	mProfileDirectory: Components.classes["@mozilla.org/file/directory_service;1"].getService(Components.interfaces.nsIProperties).get("ProfD", Components.interfaces.nsILocalFile),
	mIOService: Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService),
	mSecretDecoderRing: Components.classes["@mozilla.org/security/sdr;1"].getService(Components.interfaces.nsISecretDecoderRing),
	mNativeJSON: Components.classes["@mozilla.org/dom/json;1"].createInstance(Components.interfaces.nsIJSON),
	mSMHelper: Components.classes["@morac/sessionmanager-helper;1"].getService(Components.interfaces.nsISessionManangerHelperComponent),
	mVersionCompare: Components.classes["@mozilla.org/xpcom/version-comparator;1"].getService(Components.interfaces.nsIVersionComparator),
	mComponents: Components,
	
	// conditional Browser Components (may or may not exist)
	mPrivateBrowsing: null,
	mSessionStore : null,
	mSessionStartup : null,
	mApplication: null,

	mObserving: ["sessionmanager:windowtabopenclose", "sessionmanager:updatetitlebar", "sessionmanager:initial-windows-restored",
	             "sessionmanager:close-windowsession", "browser:purge-session-history", "quit-application-requested", "quit-application-granted"],
	// These won't be removed on last window closed since we still need to watch for them.
	mObserving2: ["quit-application", "private-browsing-change-granted", "sessionmanager:process-closed-window"],
	mClosedWindowFile: "sessionmanager.dat",
	mBackupSessionName: "backup.session",
	mBackupSessionRegEx: /^backup(-[1-9](\d)*)?\.session$/,
	mAutoSaveSessionName: "autosave.session",
	mSessionExt: ".session",
	mFirstUrl: "http://sessionmanager.mozdev.org/documentation.html",
	mSessionRegExp: /^\[SessionManager v2\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session\/?\d*|window\/?\d*)\tcount=([1-9][0-9]*)\/([1-9][0-9]*)(\tgroup=([^\t|^\n|^\r]+))?(\tscreensize=(\d+)x(\d+))?/m,

	mLastState: null,
	mCleanBrowser: null,
	mClosedWindowName: null,
	
	mSessionCache: "sessionmanager.cache.session.",
	mClosedWindowsCacheData: "sessionmanager.cache.closedWindows.data",
	mClosedWindowsCacheTimestamp: "sessionmanager.cache.closedWindows.timestamp",
	mClosedWindowsCacheLength: "sessionmanager.cache.closedWindows.length",
	mActiveWindowSessions: "sessionmanager.activeWindowSessions",
	mAlreadyShutdown: "sessionmanager.alreadyShutdown",
	mSanitizePreference: "privacy.item.extensions-sessionmanager",
	
	getSessionStoreComponent : function() {
		// Firefox or SeaMonkey
		var sessionStore = Components.classes["@mozilla.org/browser/sessionstore;1"] || Components.classes["@mozilla.org/suite/sessionstore;1"];
		var sessionStart = Components.classes["@mozilla.org/browser/sessionstartup;1"] || Components.classes["@mozilla.org/suite/sessionstartup;1"];
		
		if (sessionStore && sessionStart) {
			this.mSessionStore = sessionStore.getService(Components.interfaces.nsISessionStore);
			this.mSessionStartup = sessionStart.getService(Components.interfaces.nsISessionStartup);
		}
		// Not supported
		else {
			window.addEventListener("load", gSessionManager.onLoad_Uninstall, false);
			return false;
		}
		return true;
	},
	
	initialize: function()
	{
		// import logger function into gSessionManager
		Components.utils.import("resource://sessionmanager/modules/logger.js", this);
	
		// Define Constants using closure functions
		const STARTUP_PROMPT = -11;
		const STARTUP_LOAD = -12;
	
		this.STARTUP_PROMPT = function() { return STARTUP_PROMPT; }
		this.STARTUP_LOAD = function() { return STARTUP_LOAD; }
		
		// Get SessionStore service component 
		if (!this.getSessionStoreComponent()) return false;
		
		// Get FUEL (SMILE in SeaMonkey) library
		if (Components.classes["@mozilla.org/fuel/application;1"]) {
			this.mApplication = Components.classes["@mozilla.org/fuel/application;1"].getService(Components.interfaces.fuelIApplication);
		} else if (Components.classes["@mozilla.org/smile/application;1"]) {
			this.mApplication = Components.classes["@mozilla.org/smile/application;1"].getService(Components.interfaces.smileIApplication);
		}
		if (!this.mApplication) return false;
		
		// Set Private Browser service variable
		var privateBrowsing = Components.classes["@mozilla.org/privatebrowsing;1"];
		if (privateBrowsing)
			this.mPrivateBrowsing = privateBrowsing.getService(Components.interfaces.nsIPrivateBrowsingService);
			
		// If the shutdown on last window closed preference is not set, set it based on the O/S.
		// Enable for Macs, disable for everything else
		if (!this.mPrefRoot.prefHasUserValue("extensions.sessionmanager.shutdown_on_last_window_close")) {
			if (/mac/i.test(navigator.platform)) {
				this.setPref("extensions.sessionmanager.shutdown_on_last_window_close", true, true);
			}
			else {
				this.setPref("extensions.sessionmanager.shutdown_on_last_window_close", false, true);
			}
		}
		
		return true;
	},

/* ........ Listeners / Observers.............. */

	onLoad_proxy: function()
	{
		this.removeEventListener("load", gSessionManager.onLoad_proxy, false);
		
		// The close event fires when the window is either manually closed or when the window.close() function is called.  It does not fire on shutdown or when
		// windows close from loading sessions.  The unload event fires any time the window is closed, but fires too late to use SessionStore's setWindowValue.
		// We need to listen to both of them so that the window session window value can be cleared when the window is closed manually.
		// The window value is also cleared on a "quit-application-granted", but that doesn't fire when the last browser window is manually closed.
		window.addEventListener("close", gSessionManager.onClose_proxy, false);			
		window.addEventListener("unload", gSessionManager.onUnload_proxy, false);			
		gSessionManager.onLoad();
	},

	onLoad: function(aDialog)
	{
		this.log("onLoad start, aDialog = " + aDialog, "TRACE");
		
		this.mEOL = this.getEOL();
		this.mBundle = document.getElementById("bundle_sessionmanager");
		this.mTitle = this._string("sessionManager");
		
		// Fix tooltips for toolbar buttons
		var buttons = [document.getElementById("sessionmanager-toolbar"), document.getElementById("sessionmanager-undo")];
		for (var i=0; i < buttons.length; i++) {
			if (buttons[i] && buttons[i].boxObject && buttons[i].boxObject.firstChild)
				buttons[i].boxObject.firstChild.tooltipText = buttons[i].getAttribute("buttontooltiptext");
		}

		// This will force SessionStore to be enabled since Session Manager cannot work without SessionStore being 
		// enabled and presumably anyone installing Session Manager actually wants to use it. 
		// This preference no longer exists as of Firefox 3.5 so don't set it.
		if (this.mVersionCompare.compare(this.mApplication.version,"1.9.1a1pre") < 0) {
			if (!this.getPref("browser.sessionstore.enabled", true, true)) {
				this.setPref("browser.sessionstore.enabled", true, true);
			}
		}
		
		this.mPrefBranch = this.mPrefRoot.QueryInterface(Components.interfaces.nsIPrefService).getBranch("extensions.sessionmanager.").QueryInterface(Components.interfaces.nsIPrefBranch2);
		
		// Flag to determine whether or not to use SessionStore Closed Window List (only avaiable in Firefox 3.5 and later)
		this.mUseSSClosedWindowList = (this.getPref("use_SS_closed_window_list", true)) && 
		                              (typeof(this.mSessionStore.getClosedWindowCount) == "function");
									  
		if (typeof(window.SessionManager) == "undefined") // if Tab Mix Plus isn't installed
		{
			window.SessionManager = gSessionManager;
		}
				
		if (aDialog || this.mFullyLoaded)
		{
			return;
		}
		
		// This will handle any left over processing that results from closing the last browser window, but
		// not actually exiting the browser and then opening a new browser window.  We do this before adding the observer
		// below because we don't want to run on the opening window, only on the closed window
		if (this.getBrowserWindows().length == 1) this.mObserverService.notifyObservers(window, "sessionmanager:process-closed-window", null);
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.addObserver(this, aTopic, false);
		}, this);
		this.mObserving2.forEach(function(aTopic) {
			this.mObserverService.addObserver(this, aTopic, false);
		}, this);
		
		this.mPref_append_by_default = this.getPref("append_by_default", false);
		this.mPref_autosave_session = this.getPref("autosave_session", true);
		this.mPref_backup_on_restart = this.getPref("backup_on_restart", false);
		this.mPref_backup_session = this.getPref("backup_session", 1);
		this.mPref_click_restore_tab = this.getPref("click_restore_tab", true);
		this.mPref_enable_saving_in_private_browsing_mode = this.getPref("enable_saving_in_private_browsing_mode", false);
		this.mPref_encrypt_sessions = this.getPref("encrypt_sessions", false);
		this.mPref_encrypted_only = this.getPref("encrypted_only", false);
		this.mPref_hide_tools_menu = this.getPref("hide_tools_menu", false);
		this.mPref_max_backup_keep = this.getPref("max_backup_keep", 0);
		this.mPref_max_closed_undo = this.getPref("max_closed_undo", 10);
		this.mPref_max_display = this.getPref("max_display", 20);
		this.mPref_logging = this.getPref("extensions.sessionmanager.logging", false, true);
		this.mPref_name_format = this.getPref("name_format", "%40t-%d");
		this.mPref_overwrite = this.getPref("overwrite", false);
		this.mPref_preselect_previous_session = this.getPref("preselect_previous_session", false);
		this.mPref_reload = this.getPref("reload", false);
		this.mPref_restore_temporary = this.getPref("restore_temporary", false);
		this.mPref_resume_session = this.getPref("resume_session", this.mBackupSessionName);
		this.mPref_save_closed_tabs = this.getPref("save_closed_tabs", 2);
		this.mPref_save_closed_windows = this.getPref("save_closed_windows", 2);
		this.mPref_save_cookies = this.getPref("save_cookies", false);
		this.mPref_save_window_list = this.getPref("save_window_list", false);
		this.mPref_session_list_order = this.getPref("session_list_order", 1);
		this.mPref_session_name_in_titlebar = this.getPref("session_name_in_titlebar", 0);
		this.mPref_shutdown_on_last_window_close = this.getPref("shutdown_on_last_window_close", false);
		this.mPref_startup = this.getPref("startup",0);
		this.mPref_submenus = this.getPref("submenus", false);
		this._temp_restore = this.mApplication.storage.get("sessionmanager.command_line_data", null);
		
		// make sure command line data is cleared
		if (this._temp_restore) this.mApplication.storage.set("sessionmanager.command_line_data", null);
		
		// split out name and group
		this.getAutoSaveValues(this.getPref("_autosave_values", ""));
		this.mPrefBranch.addObserver("", this, false);
		
		gBrowser.addEventListener("TabClose", this.onTabOpenClose, false);
		gBrowser.addEventListener("TabOpen", this.onTabOpenClose, false)
		if (this.mPref_reload) {
			gBrowser.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
			gBrowser.addEventListener("SSTabRestored", this.onTabRestored_proxy, false);
		}
		
		// Make sure resume_session is not null.  This could happen in 0.6.2.  It should no longer occur, but 
		// better safe than sorry.
		if (!this.mPref_resume_session) {
			this.setPref("resume_session", this.mBackupSessionName);
			if (this.mPref_startup == 2) this.setPref("startup",0);
		}
		
		// Hide Session Manager toolbar item if option requested
		this.showHideToolsMenu();
		
		// Undo close tab if middle click on tab bar - only do this if Tab Clicking Options
		// or Tab Mix Plus are not installed.
		this.watchForMiddleMouseClicks();

		// Handle restoring sessions do to crash, prompting, pre-chosen session, etc
		this.recoverSession();
		this.updateToolbarButton();
		
		// Tell Session Manager Helper Component that it's okay to restore the browser startup preference if it hasn't done so already
		this.mObserverService.notifyObservers(null, "sessionmanager:restore-startup-preference", null);
		
		// Update other browsers toolbars in case this was a restored window
		if (this.mUseSSClosedWindowList) {
			this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
		}
		
		if (!this.isRunning())
		{
			// make sure that the _running storage value is running
			this.setRunning(true);
		
			// If backup file is temporary, then delete it
			try {
				if (this.getPref("backup_temporary", true)) {
					this.setPref("backup_temporary", false)
					this.delFile(this.getSessionDir(this.mBackupSessionName));
				}
			} catch (ex) { this.logError(ex); }

			// If we did a temporary restore, set it to false			
			if (this.mPref_restore_temporary) this.setPref("restore_temporary", false)

			// Force saving the preferences
			this.mObserverService.notifyObservers(null,"sessionmanager-preference-save",null);
		}
		else if (this.getPref("_save_prefs",false)) {
			// Save preference file if this preference is true in order to prevent problems on a crash.
			// It is set to true if an autosave session crashed and user did not resume it.
			this.delPref("_save_prefs");
			this.mObserverService.notifyObservers(null,"sessionmanager-preference-save",null);
		}
		this.mFullyLoaded = true;
		
		// Watch for changes to the titlebar so we can add our sessionname after it since 
		// DOMTitleChanged doesn't fire every time the title changes in the titlebar.
		gBrowser.ownerDocument.watch("title", gSessionManager.updateTitlebar);
		gBrowser.updateTitlebar();

		// Workaround for bug 366986
		// TabClose event fires too late to use SetTabValue to save the "image" attribute value and have it be saved by SessionStore
		// so make the image tag persistant so it can be read later from the xultab variable.
		this.mSessionStore.persistTabAttribute("image");
		
		// SeaMonkey doesn't have an undoCloseTab function so create one
		if (typeof(undoCloseTab) == "undefined") {
			undoCloseTab = function(aIndex) { gSessionManager.undoCloseTabSM(aIndex); }
		}
		
		// add call to gSessionManager_Sanitizer (code take from Tab Mix Plus)
		// nsBrowserGlue.js use loadSubScript to load Sanitizer so we need to add this here for the case
		// where the user disabled option to prompt before clearing data 
		var cmd = document.getElementById("Tools:Sanitize");
		if (cmd) cmd.setAttribute("oncommand", "gSessionManager.tryToSanitize();" + cmd.getAttribute("oncommand"));
		
		// Clear current window value setting if shouldn't be set.  Need try catch because first browser window will throw an exception.
		try {
			if (!this.__window_session_name) {
				// Backup _sm_window_session_values first in case this is actually a restart or crash restore 
				this._backup_window_sesion_data = this.mSessionStore.getWindowValue(window,"_sm_window_session_values");
				if (this._backup_window_sesion_data) this.getAutoSaveValues(null, true);
			}
		} catch(ex) {}
		
		// Perform any needed update processing
		var oldVersion = this.getPref("version", "")
		var newVersion = this.mApplication.extensions.get("{1280606b-2510-4fe0-97ef-9b5a22eafe30}").version;
		if (oldVersion != newVersion)
		{
			// Fix the closed window data if it's encrypted
			if ((this.mVersionCompare.compare(oldVersion, "0.6.4.2") < 0) && !this.mUseSSClosedWindowList) {
				// if encryption enabled
				if (this.mPref_encrypt_sessions) {
					var windows = this.getClosedWindows_SM();
					
					// if any closed windows
					if (windows.length) {
						var encrypt_okay = false;
						while (!encrypt_okay) {
							try {
								// force a master password prompt so we don't waste time if user cancels it
								this.mSecretDecoderRing.encryptString("");
								encrypt_okay = true;
							}
							catch(ex) {};
						}

						windows.forEach(function(aWindow) {
							aWindow.state = this.decrypt(aWindow.state, true, true);
							aWindow.state = this.decryptEncryptByPreference(aWindow.state);
						}, this);
						this.storeClosedWindows_SM(windows);
					}
				}
			}

			// this isn't used anymore
			if (this.mVersionCompare.compare(oldVersion, "0.6.2.5") < 0) this.delPref("_no_reload");

			// Clean out screenX and screenY persist values from localstore.rdf since we don't persist anymore.
			if (this.mVersionCompare.compare(oldVersion, "0.6.2.1") < 0) {
				var RDF = Components.classes["@mozilla.org/rdf/rdf-service;1"].getService(Components.interfaces.nsIRDFService);
				var ls = Components.classes["@mozilla.org/rdf/datasource;1?name=local-store"].getService(Components.interfaces.nsIRDFDataSource);
				var rdfNode = RDF.GetResource("chrome://sessionmanager/content/options.xul#sessionmanagerOptions");
				var arcOut = ls.ArcLabelsOut(rdfNode);
				while (arcOut.hasMoreElements()) {
					var aLabel = arcOut.getNext();
					if (aLabel instanceof Components.interfaces.nsIRDFResource) {
						var aTarget = ls.GetTarget(rdfNode, aLabel, true);
						ls.Unassert(rdfNode, aLabel, aTarget);
					}
				}
				ls.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource).Flush();
			}
						
			// Add backup sessions to backup group
			if (this.mVersionCompare.compare(oldVersion, "0.6.2.8") < 0) {
				var sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (aSession.backup) {
						this.group(aSession.fileName, this._string("backup_sessions"));
					}
				}, this);
			}
			
			this.setPref("version", newVersion);
			
			// If development version, go to development change page
			if (/\.20[0-9][0-9][0-1][0-9][1-3][0-9]/.test(newVersion)) {
				this.mFirstUrl = "http://sessionmanager.mozdev.org/changelog.xhtml";
			}
			
			// One time message on update
			if (this.getPref("update_message", true)) {
				setTimeout(function() {
					var tBrowser = getBrowser();
					tBrowser.selectedTab = tBrowser.addTab(gSessionManager.mFirstUrl);
				},100);
			}
			
		}
		this.log("onLoad end", "TRACE");
	},

	// If SessionStore component does not exist hide Session Manager GUI and uninstall
	onLoad_Uninstall: function()
	{
		window.removeEventListener("load", gSessionManager.onLoad_Uninstall, false);
		window.addEventListener("unload", gSessionManager.onUnload_Uninstall, false);
	
		var sessionButton = document.getElementById("sessionmanager-toolbar");
		var undoButton = document.getElementById("sessionmanager-undo");
		var sessionMenu = document.getElementById("sessionmanager-menu");
		if (sessionButton) sessionButton.hidden = true;
		if (undoButton) undoButton.hidden = true;
		if (sessionMenu) sessionMenu.hidden = true;
	
		if (!gSessionManager.getPref("browser.sessionmanager.uninstalled", false, true)) {
			var bundle = document.getElementById("bundle_sessionmanager");
			var title = bundle.getString("sessionManager");
			var text = bundle.getString("not_supported");
			var promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);
			setTimeout(function() { promptService.alert((bundle)?window:null, title, text); }, 0);
			var liExtensionManager = Components.classes["@mozilla.org/extensions/manager;1"].getService(Components.interfaces.nsIExtensionManager);
			liExtensionManager.uninstallItem("{1280606b-2510-4fe0-97ef-9b5a22eafe30}");
			gSessionManager.setPref("browser.sessionmanager.uninstalled", true, true);
		}
	},
	
	// If uninstalling because of incompatability remove preference
	onUnload_Uninstall: function()
	{
		this.removeEventListener("unload", gSessionManager.onUnload_Uninstall, false);
		
		// last window closing, delete preference
		if (gSessionManager.getBrowserWindows().length == 1) {
			gSessionManager.delPref("browser.sessionmanager.uninstalled", true);
		}
	},
	
	// This fires only when the window is manually closed by using the "X" or via a window.close() call
	onClose_proxy: function()
	{
		gSessionManager.log("onClose Fired", "INFO");
		this.removeEventListener("close", gSessionManager.onClose_proxy, false);
		// This fires before the window closes so decrement the window count
		gSessionManager.onWindowClose(true);
	},

	// This fires any time the window is closed.  It fires too late to use SessionStore's setWindowValue.
	onUnload_proxy: function()
	{
		gSessionManager.log("onUnload Fired", "INFO");
		this.removeEventListener("unload", gSessionManager.onUnload_proxy, false);
		gSessionManager.onUnload();
	},

	onUnload: function()
	{
		this.log("onUnload start", "TRACE");
		var allWindows = this.getBrowserWindows();
		var numWindows = allWindows.length;
		this.log("onUnload: numWindows = " + numWindows, "DATA");
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.removeObserver(this, aTopic);
		}, this);
		this.mPrefBranch.removeObserver("", this);
		
		gBrowser.removeEventListener("TabClose", this.onTabOpenClose, false);
		gBrowser.removeEventListener("TabOpen", this.onTabOpenClose, false);
		if (this.mPref_reload) {
			gBrowser.removeEventListener("SSTabRestored", this.onTabRestored_proxy, false);
			gBrowser.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
		}
		gBrowser.mStrip.removeEventListener("click", this.onTabBarClick, false);
		
		// stop watching for titlebar changes
		gBrowser.ownerDocument.unwatch("title");
		
		// Last window closing will leaks briefly since mObserving2 observers are not removed from it 
		// until after shutdown is run, but since browser is closing anyway, who cares?
		if (numWindows != 0) {
			this.mObserving2.forEach(function(aTopic) {
				this.mObserverService.removeObserver(this, aTopic);
			}, this);
		}
		
		// Stop Session timer and start another if needed
		if (this._timer) { 
			this.log("onUnload: Session Timer stopped because window closed", "INFO");
			this._timer.cancel();
			this._timer = null;
			if (numWindows != 0) allWindows[0].gSessionManager.checkTimer();
		}

		// Only call onWindowClose here if shutting down since the close event doesn't fire in that case.
		if (this.mPref__stopping) this.onWindowClose();
						
		// This executes whenever the last browser window is closed (either manually or via shutdown).
		if (this.isRunning() && numWindows == 0)
		{
			this._string_preserve_session = this._string("preserve_session");
			this._string_backup_session = this._string("backup_session");
			this._string_backup_sessions = this._string("backup_sessions");
			this._string_old_backup_session = this._string("old_backup_session");
			this._string_prompt_not_again = this._string("prompt_not_again");
			this._string_encrypt_fail = this._string("encrypt_fail");
			this._string_encrypt_fail2 = this._string("encrypt_fail2");
			this._string_save_and_restore = this._string("save_and_restore");
			this._screen_width = screen.width;
			this._screen_height = screen.height;
			
			this.mTitle += " - " + document.getElementById("bundle_brand").getString("brandFullName");

			// This will run the shutdown processing if the preference is set and the last browser window is closed manually
			if (this.mPref_shutdown_on_last_window_close && !this.mPref__stopping) {
				this.mObserving2.forEach(function(aTopic) {
					this.mObserverService.removeObserver(this, aTopic);
				}, this);
				this.shutDown();
				// Don't look at the session startup type if a new window is opened without shutting down the browser.
				Application.storage.set(this.mAlreadyShutdown, true)
			}
		}
		this.mBundle = null;
		this.mFullyLoaded = false;
		this.log("onUnload end", "TRACE");
	},

	observe: function(aSubject, aTopic, aData)
	{
		this.log("observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "sessionmanager:close-windowsession":
			// notification will either specify specific window session name or be null for all window sessions
			if (this.__window_session_name && (!aData || (this.__window_session_name == aData))) {
				var abandon = aSubject.QueryInterface(this.mComponents.interfaces.nsISupportsPRBool).data;
				this.log((abandon ? "Abandoning" : "Closing") + " window session " + this.__window_session_name);
				if (abandon) {
					this.abandonSession(true);
				}
				else {
					this.closeSession(true);
				}
			}
			break;
		case "sessionmanager:initial-windows-restored":
			// check both the backup and current window value just in case
			var window_values = this._backup_window_sesion_data || this.mSessionStore.getWindowValue(window,"_sm_window_session_values");
			if (window_values) this.getAutoSaveValues(window_values, true);
			this.log("observe: Restore new window done, window session = " + this.__window_session_name, "DATA");
			this._backup_window_sesion_data = null;
			break;
		case "sessionmanager:windowtabopenclose":
			// only update all windows if window state changed.
			if ((aData != "tab") || (window == aSubject)) this.updateToolbarButton();
			break;
		case "sessionmanager:process-closed-window":
			// This will handle any left over processing that results from closing the last browser window, but
			// not actually exiting the browser and then opening a new browser window.  The window will be
			// autosaved or saved into the closed window list depending on if it was an autosave session or not.
			// The observers will then be removed which will result in the window being removed from memory.
			if (window != aSubject) {
				try { 
					if (!this.closeSession(false)) this.onWindowClose();
				}
				catch(ex) { this.logError(ex); }
				this.mLastState = null;
				this.mCleanBrowser = null;
				this.mClosedWindowName = null;
				this.mObserving2.forEach(function(aTopic) {
					this.mObserverService.removeObserver(this, aTopic);
				}, this);
				this.log("observe: done processing closed window", "INFO");
			}
			break;
		case "sessionmanager:updatetitlebar":
			gBrowser.updateTitlebar();
			break;
		case "browser:purge-session-history":
			this.clearUndoData("all");
			break;
		case "private-browsing-change-granted":
			switch(aData) {
			case "enter":
				// Only do the following once
				if (!this.doNotDoPrivateProcessing) {
					// Close current autosave session or make an autosave backup (if not already in private browsing mode)
					if (!this.closeSession(false,true) && this.mPref_autosave_session) {
					    // If autostart or disabling history via options, make a real backup, otherwise make a temporary backup
						if (this.isAutoStartPrivateBrowserMode()) {
							this.backupCurrentSession();
						}
						else {
							this.autoSaveCurrentSession(true); 
						}
					}

					// Prevent other windows from doing the saving processing
					this.getBrowserWindows().forEach(function(aWindow) {
						if (aWindow != window) { 
							aWindow.gSessionManager.doNotDoPrivateProcessing = true; 
						}
					});
				}
				break;
			case "exit":
				this.doNotDoPrivateProcessing = false;
				// If browser shutting down, set flag
				aSubject.QueryInterface(this.mComponents.interfaces.nsISupportsPRBool);
				if (aSubject.data) {
					if (!this.mPref_enable_saving_in_private_browsing_mode || !this.mPref_encrypt_sessions) {
						this.mShutDownInPrivateBrowsingMode = true;
					}
				}
				break;
			}
			break;
		case "nsPref:changed":
			this["mPref_" + aData] = this.getPref(aData);
			
			switch (aData)
			{
			case "click_restore_tab":
				this.watchForMiddleMouseClicks();
				break;
			case "encrypt_sessions":
				this.encryptionChange();
				break;
			case "max_closed_undo":
				if (!this.mUseSSClosedWindowList) {
					if (this.mPref_max_closed_undo == 0)
					{
						this.clearUndoData("window", true);
					}
					else
					{
						var closedWindows = this.getClosedWindows_SM();
						if (closedWindows.length > this.mPref_max_closed_undo)
						{
							this.storeClosedWindows_SM(closedWindows.slice(0, this.mPref_max_closed_undo));
						}
					}
				}
				break;
			case "_autosave_values":
				// split out name and group
				this.getAutoSaveValues(this.mPref__autosave_values);
				this.mPref__autosave_values = null;
				this.checkTimer();
				gBrowser.updateTitlebar();
				break;
			case "hide_tools_menu":
				this.showHideToolsMenu();
				break;
			case "reload":
				if (this.mPref_reload) {
					gBrowser.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
					gBrowser.addEventListener("SSTabRestored", this.onTabRestored_proxy, false);
				}
				else {
					gBrowser.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
					gBrowser.removeEventListener("SSTabRestored", this.onTabRestored_proxy, false);
				}
				break;
			case "use_SS_closed_window_list":
				// Flag to determine whether or not to use SessionStore Closed Window List
				this.mUseSSClosedWindowList = (this.mPref_use_SS_closed_window_list && 
				                               typeof(this.mSessionStore.getClosedWindowCount) == "function");
				this.updateToolbarButton();
				break;
			case "session_name_in_titlebar":
				gBrowser.updateTitlebar();
				break;
			}
			break;
		case "quit-application":
			this.mObserving2.forEach(function(aTopic) {
				this.mObserverService.removeObserver(this, aTopic);
			}, this);
			// only run shutdown for one window and if not restarting browser (or on restart is user wants)
			if (this.mPref_backup_on_restart || (aData != "restart"))
			{
				this.shutDown();
			}
			else
			{
				// Save any active auto-save session, but leave it open.
				this.closeSession(false, false, true);
			}
			break;
		case "quit-application-requested":
			this._restart_requested = (aData == "restart");
			break;
		case "quit-application-granted":
			// If not restarting or if this window doesn't have a window session open, 
			// hurry and wipe out the window session value before Session Store stops allowing 
			// window values to be updated.
			if (!this._restart_requested || !this.__window_session_name) {
				this.log("Clearing window session data", "INFO");
				// this throws if it doesn't exist so try/catch it
				try { 
					this.mSessionStore.deleteWindowValue(window, "_sm_window_session_values");
				}
				catch(ex) {}
			}
		
			// quit granted so stop listening for closed windows
			this.mPref__stopping = true;
			this._mUserDirectory = this.getUserDir("sessions");
			break;
		// timer periodic call
		case "timer-callback":
			// save auto-save or window session if open, but don't close it
			this.log("Timer callback for " + ((aSubject == this._win_timer) ? "window" : "session" ) + " timer", "EXTRA");
			this.closeSession((aSubject == this._win_timer), false, true);
			break;
		}
	},

	onTabOpenClose: function(aEvent)
	{
		// Give browser a chance to update count closed tab count.  Only SeaMonkey currently needs this, but it doesn't hurt Firefox.
		setTimeout(function() { gSessionManager.updateToolbarButton(); }, 0);
	},
	
	// This is to try and prevent tabs that are closed during the restore preocess from actually reloading.  
	// It doesn't work all the time, but it's better than nothing.
	onTabRestoring_proxy: function(aEvent) {
		// If tab reloading enabled and not offline
		if (gSessionManager.mPref_reload && !gSessionManager.mIOService.offline) {

			var sessionStore = gSessionManager.mSessionStore;
			if (sessionStore.getTabValue(aEvent.originalTarget, "session_manager_reload")) {
				sessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_reload");
			}
			else if (sessionStore.getTabValue(aEvent.originalTarget, "session_manager_allow_reload")) {
				sessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_allow_reload");
				sessionStore.setTabValue(aEvent.originalTarget, "session_manager_reload", true);
			}
		}
	},

	onTabRestored_proxy: function(aEvent)
	{
		// If tab reloading enabled and not offline
		if (gSessionManager.mPref_reload && !gSessionManager.mIOService.offline) {

			// Restore tabs that are marked restore.
			var sessionStore = gSessionManager.mSessionStore;
			var allowReload = sessionStore.getTabValue(aEvent.originalTarget, "session_manager_reload");
			if (allowReload == "true")
			{
				var nsIWebNavigation = Components.interfaces.nsIWebNavigation;
				var browser = this.getBrowserForTab(aEvent.originalTarget);
				browser.reloadWithFlags(nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
				
				// no longer allow tab to reload
				try {
					sessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_reload");
					sessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_allow_reload");
				}
				catch (ex) {}
			}
		}
	},
	
	onTabBarClick: function(aEvent)
	{
		//undo close tab on middle click on tab bar
		if (aEvent.button == 1 && aEvent.target.localName != "tab")
		{
			undoCloseTab();
		}
	},

	onToolbarClick: function(aEvent, aButton)
	{
		if (aEvent.button == 1)
		{
			// simulate shift left clicking toolbar button when middle click is used
			var event = document.createEvent("XULCommandEvents");
			event.initCommandEvent("command", false, true, window, 0, false, false, true, false, null);
			aButton.dispatchEvent(event);
		}
		else if (aEvent.button == 2 && aButton.getAttribute("disabled") != "true")
		{
			aButton.open = true;
		}
	},

	onWindowClose: function(aDecrementCount)
	{
		this.log("onWindowClosed start", "TRACE");
		// if there is a window session save it (leave it open if browser is restarting)
		if (this.__window_session_name) 
		{
			this.closeSession(true, false, this._restart_requested);
		}
			
		this.log("onWindowClose: running = " + this.isRunning() + ", stopping = " + this.mPref__stopping, "DATA");
		// only save closed window if running and not shutting down 
		if (this.isRunning() && !this.mPref__stopping)
		{
			// Get number of windows open after closing this one.  If called from close event, decrement count by one.
			var numWindows = this.getBrowserWindows().length - (aDecrementCount ? 1 : 0);
			
			this.log("onWindowClose: numWindows = " + numWindows, "DATA");
			// save window in closed window list if not last window, otherwise store the last window state for use later
			if (numWindows > 0)
			{
				if (!this.mUseSSClosedWindowList) {
					var state = this.getSessionState(null, true, null, null, null, true);
					this.appendClosedWindow(state);
				}
				this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
			}
			else
			{
				// store current session data in case it's needed later
				var name = (this.mPref__autosave_name) ? this.mPref__autosave_name : null;
				try {
					this.mLastState = (name) ? 
	    	               this.getSessionState(name, null, this.getNoUndoData(), true, this.mPref__autosave_group, true, this.mPref__autosave_time) :
	        	           this.getSessionState(null, true, null, null, null, true); 
					this.mCleanBrowser = Array.every(gBrowser.browsers, this.isCleanBrowser);
					this.mClosedWindowName = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:this._string("untitled_window"));
				}
				catch(ex) { 
					this.logError(ex); 
				}
			}
		}
		this.log("onWindowClosed end", "TRACE");
	},
	
	// Put current session name in browser titlebar
	// This is a watch function which is called any time the titlebar text changes
	// See https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Global_Objects/Object/watch
	updateTitlebar: function(id, oldVal, newVal)
	{
		if (id == "title") {
			// Don't kill browser if something goes wrong
			try {
				var windowTitleName = (gSessionManager.__window_session_name) ? (gSessionManager._string("window_session") + " " + gSessionManager.__window_session_name) : "";
				var sessionTitleName = (gSessionManager.mPref__autosave_name) ? (gSessionManager._string("current_session2") + " " + gSessionManager.mPref__autosave_name) : "";
				var title = ((windowTitleName || sessionTitleName) ? "(" : "") + windowTitleName + ((windowTitleName && sessionTitleName) ? ", " : "") + sessionTitleName + ((windowTitleName || sessionTitleName) ? ")" : "")
				
				// Add window and browser session titles
				switch(gSessionManager.mPref_session_name_in_titlebar) {
					case 0:
						newVal = newVal + " - " + title;
						break;
					case 1:
						newVal = title + " - " + newVal;
						break;
				}
			} 
			catch (ex) { 
				gSessionManager.logError(ex); 
			}
		}
		return newVal;
	},
	
	// Undo close tab if middle click on tab bar if enabled by user - only do this if Tab Clicking Options
	// or Tab Mix Plus are not installed.
	watchForMiddleMouseClicks: function() 
	{
		if (this.mPref_click_restore_tab && (typeof(tabClicking) == "undefined") && (typeof(TM_checkClick) == "undefined")) {
			gBrowser.mStrip.addEventListener("click", this.onTabBarClick, false);
		}
		else gBrowser.mStrip.removeEventListener("click", this.onTabBarClick, false);
	},

/* ........ Menu Event Handlers .............. */

	init: function(aPopup, aIsToolbar)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var separator = get_("separator");
		var backupSep = get_("backup-separator");
		var startSep = get_("start-separator");
		var closer = get_("closer");
		var closerWindow = get_("closer_window");
		var abandon = get_("abandon");
		var abandonWindow = get_("abandon_window");
		var save = get_("save");
		var backupMenu = get_("backup-menu");
				
		for (var item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		// The first time this function is run after an item is added or removed from the browser toolbar
		// using the customize feature, the backupMenu.menupopup value is not defined.  This happens once for
		// each menu (tools menu and toolbar button).  Using the backupMenu.firstChild will work around this
		// Firefox bug, even though it technically isn't needed.
		var backupPopup = backupMenu.menupopup || backupMenu.firstChild; 
		while (backupPopup.childNodes.length) backupPopup.removeChild(backupPopup.childNodes[0]);
		
		closer.hidden = abandon.hidden = (this.mPref__autosave_name=="");
		closerWindow.hidden = abandonWindow.hidden = !this.__window_session_name;
		//save.hidden = (this.getBrowserWindows().length == 1);
		
		// Disable saving in privacy mode
		var inPrivateBrowsing = this.isPrivateBrowserMode();
		this.setDisabled(save, inPrivateBrowsing);
		this.setDisabled(save.previousSibling, inPrivateBrowsing);
		this.setDisabled(save.nextSibling, inPrivateBrowsing);
		
		var windowSessions = this.getWindowSessions();
		var sessions = this.getSessions();
		var groupNames = [];
		var groupMenus = {};
		var count = 0;
		var backupCount = 0;
		var user_latest = false;
		var backup_latest = false;
		sessions.forEach(function(aSession, aIx) {
			if (!aSession.backup && !aSession.group && (this.mPref_max_display >= 0) && (count >= this.mPref_max_display)) return;
	
			var key = (aSession.backup || aSession.group)?"":(++count < 10)?count:(count == 10)?"0":"";
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", ((key)?key + ") ":"") + aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("oncommand", 'gSessionManager.load("' + aSession.fileName + '", (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.shiftKey)?"newwindow":(event.ctrlKey || event.metaKey)?"append":"");');
			menuitem.setAttribute("onclick", 'if (event.button == 1) gSessionManager.load("' + aSession.fileName + '", "newwindow");');
			menuitem.setAttribute("contextmenu", "sessionmanager-ContextMenu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("backup-item", aSession.backup);
			menuitem.setAttribute("accesskey", key);
			menuitem.setAttribute("autosave", /^window|session/.exec(aSession.autosave));
			menuitem.setAttribute("disabled", windowSessions[aSession.name.trim().toLowerCase()] || false);
			menuitem.setAttribute("crop", "center");
			// only display one latest (even if two have the same timestamp)
			if (!(aSession.backup?backup_latest:user_latest) &&
			    ((aSession.backup?sessions.latestBackUpTime:sessions.latestTime) == aSession.timestamp)) {
				menuitem.setAttribute("latest", true);
				if (aSession.backup) backup_latest = true;
				else user_latest = true;
			}
			if (aSession.name == this.mPref__autosave_name) menuitem.setAttribute("disabled", true);
			if (aSession.backup) {
				backupCount++;
				backupPopup.appendChild(menuitem);
			}
			else {
				if (aSession.group) {
					var groupMenu = groupMenus[aSession.group];
					if (!groupMenu) {
						groupMenu = document.createElement("menu");
						groupMenu.setAttribute("_id", aSession.group);
						groupMenu.setAttribute("label", aSession.group);
						groupMenu.setAttribute("accesskey", aSession.group.charAt(0));
						groupMenu.setAttribute("contextmenu", "sessionmanager-groupContextMenu");
						var groupPopup = document.createElement("menupopup");
						groupPopup.setAttribute("onpopupshowing", "event.stopPropagation();");
						groupMenu.appendChild(groupPopup);
						
						groupNames.push(aSession.group);
						groupMenus[aSession.group] = groupMenu;
					}
					var groupPopup = groupMenu.menupopup || groupMenu.lastChild; 
					groupPopup.appendChild(menuitem);
				}
				else aPopup.insertBefore(menuitem, separator);
			}
		}, this);
		
		// Display groups in alphabetical order at the top of the list
		if (groupNames.length) {
			groupNames.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
			var insertBeforeEntry = startSep.nextSibling;
			
			groupNames.forEach(function(aGroup, aIx) {
				aPopup.insertBefore(groupMenus[aGroup], insertBeforeEntry);
			},this);
		}
		
		backupSep.hidden = backupMenu.hidden = (backupCount == 0);
		separator.hidden = (this.mPref_max_display == 0) || ((sessions.length - backupCount) == 0);
		this.setDisabled(separator.nextSibling, separator.hidden && backupSep.hidden);
		this.setDisabled(separator.nextSibling.nextSibling, separator.hidden && backupSep.hidden);
		
		var undoMenu = get_("undo-menu");
		while (aPopup.lastChild != undoMenu)
		{
			aPopup.removeChild(aPopup.lastChild);
		}
		
		var undoDisabled = ((this.getPref("browser.sessionstore.max_tabs_undo", 10, true) == 0) &&
		                    ((!this.mUseSSClosedWindowList && (this.mPref_max_closed_undo == 0)) ||
							 (this.mUseSSClosedWindowList && this.getPref("browser.sessionstore.max_windows_undo", 10, true) == 0)));
		var divertedMenu = aIsToolbar && document.getElementById("sessionmanager-undo");
		var canUndo = !undoDisabled && !divertedMenu && this.initUndo(undoMenu.firstChild);
		
		undoMenu.hidden = undoDisabled || divertedMenu || !this.mPref_submenus;
		undoMenu.previousSibling.hidden = !canUndo && undoMenu.hidden;
		this.setDisabled(undoMenu, !canUndo);
		
		if (!this.mPref_submenus && canUndo)
		{
			for (item = undoMenu.firstChild.firstChild; item; item = item.nextSibling)
			{
				aPopup.appendChild(item.cloneNode(true));
				
				// Event handlers aren't copied so need to set them up again to display status bar text
				if (item.getAttribute("statustext")) {
					aPopup.lastChild.addEventListener("DOMMenuItemActive", function(event) { this.ownerDocument.getElementById("statusbar-display").setAttribute("label",this.getAttribute("statustext")); }, false);
					aPopup.lastChild.addEventListener("DOMMenuItemInactive",  function(event) { this.ownerDocument.getElementById("statusbar-display").setAttribute("label",''); }, false); 
				}
			}
		}
		
		// Bug copies tooltiptext to children so specifically set tooltiptext for all children
		if (aIsToolbar) {
			this.fixBug374288(aPopup.parentNode);
		}
	},

	save: function(aName, aFileName, aGroup, aOneWindow)
	{
		if (this.isPrivateBrowserMode()) return;
		aOneWindow = aOneWindow; // && (this.getBrowserWindows().length > 1);
		
		var values = { text: this.getFormattedName(content.document.title || "about:blank", new Date()) || (new Date()).toLocaleString(), autoSaveable : true };
		if (!aName)
		{
			if (!this.prompt(this._string("save2_session"), this._string("save_" + ((aOneWindow)?"window":"session") + "_ok"), values, this._string("save_" + ((aOneWindow)?"window":"session")), this._string("save_session_ok2")))
			{
				return;
			}
			aName = values.text;
			aFileName = values.name;
			aGroup = values.group;
		}
		if (aName)
		{
			var file = this.getSessionDir(aFileName || this.makeFileName(aName), !aFileName);
			try
			{
				this.writeFile(file, this.getSessionState(aName, aOneWindow, this.getNoUndoData(), values.autoSave, aGroup, null, values.autoSaveTime));
			}
			catch (ex)
			{
				this.ioError(ex);
			}

			// Combine auto-save values into string
			var autosaveValues = this.mergeAutoSaveValues(aName, aGroup, values.autoSaveTime);
			if (!aOneWindow)
			{
				if (values.autoSave)
				{
					this.setPref("_autosave_values", autosaveValues);
				}
				else if (this.mPref__autosave_name == aName)
				{
					// If in auto-save session and user saves on top of it as manual turn off autosave
					this.setPref("_autosave_values","");
				}
			}
			else 
			{
				if (values.autoSave)
				{
					// Store autosave values into window value and also into window variables
					this.getAutoSaveValues(autosaveValues, true);
				}
			}
		}
	},

	saveWindow: function(aName, aFileName, aGroup)
	{
		this.save(aName, aFileName, aGroup, true);
	},
	
	// if aOneWindow is true, then close the window session otherwise close the browser session
	closeSession: function(aOneWindow, aForceSave, aKeepOpen)
	{
		this.log("closeSession: " + ((aOneWindow) ? this.__window_session_name : this.mPref__autosave_name) + ", aKeepOpen = " + aKeepOpen, "DATA");
		var name = (aOneWindow) ? this.__window_session_name : this.mPref__autosave_name;
		var group = (aOneWindow) ? this.__window_session_group : this.mPref__autosave_group;
		var time = (aOneWindow) ? this.__window_session_time : this.mPref__autosave_time;
		if (name)
		{
			var file = this.getSessionDir(this.makeFileName(name));
			try
			{
				if (aForceSave || !this.isPrivateBrowserMode()) this.writeFile(file, this.getSessionState(name, aOneWindow, this.getNoUndoData(), true, group, null, time));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		
			if (!aKeepOpen) {
				if (!aOneWindow) {
					this.setPref("_autosave_values","");
				}
				else {
					this.getAutoSaveValues(null, true);
				}
			}
			return true;
		}
		return false;
	},
	
	abandonSession: function(aOneWindow)
	{
		var dontPrompt = { value: false };
		if (this.getPref("no_abandon_prompt") || this.mPromptService.confirmEx(null, this.mTitle, this._string("abandom_prompt"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			if (aOneWindow) {
				this.getAutoSaveValues(null, true);
			}
			else {
				this.setPref("_autosave_values","");
			}
			if (dontPrompt.value)
			{
				this.setPref("no_abandon_prompt", true);
			}
		}
	},

	load: function(aFileName, aMode, aChoseTabs)
	{
		this.log("load: aFileName = " + aFileName + ", aMode = " + aMode + ", aChoseTabs = " + aChoseTabs, "DATA");
		var state, chosenState, window_autosave_values, force_new_window = false, overwrite_window = false;

		if (!aFileName) {
			var values = { append_replace: true };
			aFileName = this.selectSession(this._string("load_session"), this._string("load_session_ok"), values);
			var file;
			if (!aFileName || !(file = this.getSessionDir(aFileName)) || !file.exists()) return;
			aChoseTabs = values.choseTabs;
			aMode = values.append ? "newwindow" : (values.append_window ? "append" : "overwrite");
		}
		if (aChoseTabs) {
			// Get windows and tabs chosen by user
			chosenState = this.mSMHelper.mSessionData;
			this.mSMHelper.setSessionData("");
			
			// Get session header data from disk
			state = this.readSessionFile(this.getSessionDir(aFileName), true);
		}
		else state = this.readSessionFile(this.getSessionDir(aFileName));
		if (!state)
		{
			this.ioError();
			return;
		}

		var matchArray = this.mSessionRegExp.exec(state);
		if (!matchArray)
		{
			this.ioError();
			return;
		}		
		
		// If user somehow managed to load an active Window or Auto Session, ignore it
		if ((/^window/.test(matchArray[3]) && this.mApplication.storage.get(this.mActiveWindowSessions, {})[matchArray[1].trim().toLowerCase()]) ||
		    (/^session/.test(matchArray[3]) && (this.mPref__autosave_name == matchArray[1])))
		{
			this.log("Opened an already active auto or window session: " + matchArray[1], "INFO");
			return;
		}

		// handle case when always want a new window (even if current window is blank) and
		// want to overwrite the current window, but not the current session
		switch (aMode) {
			case "newwindow_always":
				force_new_window = true;
				aMode = "newwindow";
				break;
			case "overwrite_window":
				overwrite_window = true;
				aMode = "append";			// Basically an append with overwriting tabs
				break;
		}
		
		var sessionWidth = parseInt(matchArray[9]);
		var sessionHeight = parseInt(matchArray[10]);
		var xDelta = (!sessionWidth || isNaN(sessionWidth)) ? 1 : (screen.width / sessionWidth);
		var yDelta = (!sessionHeight || isNaN(sessionHeight)) ? 1 : (screen.height / sessionHeight);
		this.log("xDelta = " + xDelta + ", yDelta = " + yDelta, "DATA");
			
		state = (aChoseTabs && chosenState) ? chosenState : state.split("\n")[4];
			
		var startup = (aMode == "startup");
		var newWindow = false;
		var overwriteTabs = true;
		var tabsToMove = null;
		var noUndoData = this.getNoUndoData(true, aMode);

		// gSingleWindowMode is set if Tab Mix Plus's single window mode is enabled
		var TMP_SingleWindowMode = (this.mPref_append_by_default && (aMode != "newwindow")) || 
		                           (typeof(gSingleWindowMode) != "undefined" && gSingleWindowMode);
		if (TMP_SingleWindowMode) this.log("Tab Mix Plus single window mode is enabled", "INFO");
	
		if (TMP_SingleWindowMode && (aMode == "newwindow" || (!startup && (aMode != "overwrite") && !this.mPref_overwrite)))
			aMode = "append";
		
		// Use specified mode or default.
		aMode = aMode || "default";
		
		if (startup)
		{
			overwriteTabs = this.isCmdLineEmpty();
			tabsToMove = (!overwriteTabs)?Array.slice(gBrowser.mTabs):null;
		}
		else if (!overwrite_window && (aMode == "append"))
		{
			overwriteTabs = false;
		}
		else if (!TMP_SingleWindowMode && (aMode == "newwindow" || (aMode != "overwrite" && !this.mPref_overwrite)))
		{
			// if there is only a blank window with no closed tabs, just use that instead of opening a new window
			var tabs = window.getBrowser();
			if (force_new_window || this.getBrowserWindows().length != 1 || !tabs || tabs.mTabs.length > 1 || 
				tabs.mTabs[0].linkedBrowser.currentURI.spec != "about:blank" || 
				this.mSessionStore.getClosedTabCount(window) > 0) {
				newWindow = true;
			}
		}
		
		// Handle case where trying to restore to a newly opened window and Tab Mix Plus's Single Window Mode is active.
		// TMP is going to close this window after the restore, so restore into existing window
		var altWindow = null;
		if (TMP_SingleWindowMode) {
			var windows = this.getBrowserWindows();
			if (windows.length == 2) {
				this.log("load: Restoring window into existing window because TMP single window mode active", "INFO");
				if (windows[0] == window) altWindow = windows[1];
				else altWindow = windows[0];
				overwriteTabs = false;
			}
		}

		// Check whether or not to close open auto and window sessions.
		// Don't save current session on startup since there isn't any.  Don't save unless 
		// overwriting existing window(s) since nothing is lost in that case.
		if (!startup) {
			if ((!newWindow && overwriteTabs) || overwrite_window) {
				// close current window sessions if open
				if (this.__window_session_name) 
				{
					this.closeSession(true);
				}
			}
			if (!newWindow && overwriteTabs && !overwrite_window)
			{
				// Closed all open window sessions
				var abandonBool = Components.classes["@mozilla.org/supports-PRBool;1"].createInstance(Components.interfaces.nsISupportsPRBool);
				abandonBool.data = false;
				this.mObserverService.notifyObservers(abandonBool, "sessionmanager:close-windowsession", null);
			
				// close current autosave session if open
				if (this.mPref__autosave_name) 
				{
					this.closeSession(false);
				}
				else 
				{
					if (this.mPref_autosave_session) this.autoSaveCurrentSession();
				}
			}
		}
		
		// If not in private browser mode and did not choose tabs and not appending to current window
		if (!aChoseTabs && !this.isPrivateBrowserMode() && overwriteTabs && !altWindow)
		{
			// if this is a window session, keep track of it
			if (/^window\/?(\d*)$/.test(matchArray[3])) {
				var time = parseInt(RegExp.$1);
				window_autosave_values = this.mergeAutoSaveValues(matchArray[1], matchArray[7], time);
				this.log("load: window session", "INFO");
			}
		
			// If this is an autosave session, keep track of it if not opening it in a new window and if there is not already an active session
			if (!newWindow && !overwrite_window && this.mPref__autosave_name=="" && /^session\/?(\d*)$/.test(matchArray[3])) 
			{
				var time = parseInt(RegExp.$1);
				this.setPref("_autosave_values", this.mergeAutoSaveValues(matchArray[1], matchArray[7], time));
			}
		}
		
		// If reload tabs enabled and not offline, set the tabs to allow reloading
		if (gSessionManager.mPref_reload && !gSessionManager.mIOService.offline) {
			try {
				state = this.decrypt(state);
				if (!state) return;
		
				var tempState = this.JSON_decode(state);
				for (var i in tempState.windows) {
					for (var j in tempState.windows[i].tabs) {
						if (tempState.windows[i].tabs[j].entries && tempState.windows[i].tabs[j].entries.length != 0) {
							if (!tempState.windows[i].tabs[j].extData) tempState.windows[i].tabs[j].extData = {};
							tempState.windows[i].tabs[j].extData["session_manager_allow_reload"] = true;
						}
					}
				}
				state = this.JSON_encode(tempState);
			}
			catch (ex) { this.logError(ex); };
		}

		setTimeout(function() {
			var tabcount = gBrowser.mTabs.length;
			var okay = gSessionManager.restoreSession((!newWindow)?(altWindow?altWindow:window):null, state, overwriteTabs, noUndoData, (overwriteTabs && !newWindow && !TMP_SingleWindowMode && !overwrite_window), 
			                                          (TMP_SingleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta);
			if (okay) {
				gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);

				if (tabsToMove)
				{
					var endPos = gBrowser.mTabs.length - 1;
					tabsToMove.forEach(function(aTab) { gBrowser.moveTabTo(aTab, endPos); });
				}
			}
			// failed to load so clear autosession in case user tried to load one
			else gSessionManager.setPref("_autosave_values", "");
		}, 0);
	},

	rename: function(aSession)
	{
		var values;
		if (aSession) values = { name: aSession, text: this.getSessionCache(aSession).name };
		else values = {};
		
		if (!this.prompt(this._string("rename_session"), this._string("rename_session_ok"), values, this._string("rename2_session")))
		{
			return;
		}
		var file = this.getSessionDir(values.name);
		var filename = this.makeFileName(values.text);
		var newFile = (filename != file.leafName)?this.getSessionDir(filename, true):null;
		
		try
		{
			if (!file || !file.exists()) throw new Error(this._string("file_not_found"));
		
			var state = this.readSessionFile(file);
			var oldname = null;
			// Get original name
			if (/^(\[SessionManager v2\])(?:\nname=(.*))?/m.test(state)) oldname = RegExp.$2;
			// remove group name if it was a backup session
			if (this.getSessionCache(values.name).backup) state = state.replace(/\tgroup=[^\t|^\n|^\r]+/m, "");
			this.writeFile(newFile || file, this.nameState(state, values.text));
			if (newFile)
			{
				if (this.mPref_resume_session == file.leafName && this.mPref_resume_session != this.mBackupSessionName &&
					this.mPref_resume_session != this.mAutoSaveSessionName)
				{
					this.setPref("resume_session", filename);
				}
				this.delFile(file);
			}

			// Update any renamed auto or window session
			this.updateAutoSaveSessions(oldname, values.text);
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	},
	
	group: function(aSession, aNewGroup)
	{
		var values = { multiSelect: true, grouping: true };
		if (typeof(aNewGroup) == "undefined") {
			aSession = this.prompt(this._string("group_session"), this._string("group_session_okay"), values, this._string("group_session_text"));
		}
		else {
			values.name = aSession;
			values.group = aNewGroup;
		}
		
		if (aSession)
		{
			var auto_save_file_name = this.makeFileName(this.mPref__autosave_name);
			values.name.split("\n").forEach(function(aFileName) {
				try
				{
					var file = this.getSessionDir(aFileName);
					if (!file || !file.exists()) throw new Error(this._string("file_not_found"));
					var state = this.readSessionFile(file);
					state = state.replace(/(\tcount=\d+\/\d+)(\tgroup=[^\t|^\n|^\r]+)?/m, function($0, $1) { return $1 + (values.group ? ("\tgroup=" + values.group.replace(/\t/g, " ")) : ""); });
					this.writeFile(file, state);

					// Grouped active session
					if (auto_save_file_name == aFileName)
					{
						this.setPref("_autosave_values", this.mergeAutoSaveValues(this.mPref__autosave_name, values.group, this.mPref__autosave_time));
					}
				}
				catch (ex)
				{
					this.ioError(ex);
				}
				
			}, this);
		}
	},

	remove: function(aSession)
	{
		if (!aSession)
		{
			aSession = this.selectSession(this._string("remove_session"), this._string("remove_session_ok"), { multiSelect: true, remove: true });
		}
		if (aSession)
		{
			aSession.split("\n").forEach(function(aFileName) {
				// If deleted autoload session, revert to no autoload session
				if ((aFileName == this.mPref_resume_session) && (aFileName != this.mBackupSessionName)) {
					this.setPref("resume_session", this.mBackupSessionName);
					this.setPref("startup", 0);
				}
				// In case deleting an auto-save or window session, update browser data
				this.updateAutoSaveSessions(this.getSessionCache(aFileName).name);
				this.delFile(this.getSessionDir(aFileName));
			}, this);
		}
	},

	openFolder: function()
	{
		var dir = this.getSessionDir();
		try {
			// "Double click" the session directory to open it
			dir.launch();
		} catch (e) {
			try {
				// If launch also fails (probably because it's not implemented), let the
				// OS handler try to open the session directory
				var uri = Components.classes["@mozilla.org/network/io-service;1"].
				          getService(Components.interfaces.nsIIOService).newFileURI(dir);
				var protocolSvc = Components.classes["@mozilla.org/uriloader/external-protocol-service;1"].
				                  getService(Components.interfaces.nsIExternalProtocolService);
				protocolSvc.loadUrl(uri);
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
	},

	openOptions: function()
	{
		var dialog = this.mWindowMediator.getMostRecentWindow("SessionManager:Options");
		if (dialog)
		{
			dialog.focus();
			return;
		}
		
		openDialog("chrome://sessionmanager/content/options.xul", "_blank", "chrome,titlebar,toolbar,centerscreen," + ((this.getPref("browser.preferences.instantApply", false, true))?"dialog=no":"modal"));
	},

/* ........ Undo Menu Event Handlers .............. */

	initUndo: function(aPopup, aStandAlone)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var separator = get_("closed-separator");
		var label = get_("windows");
		
		for (var item = separator.previousSibling; item != label; item = separator.previousSibling)
		{
			aPopup.removeChild(item);
		}
		
		var defaultIcon = (this.mApplication.name == "SEAMONKEY") ? "chrome://sessionmanager/skin/bookmark-item.png" :
		                                                            "chrome://sessionmanager/skin/defaultFavicon.png";
		
		var encrypt_okay = true;
		// make sure user enters master password if using sessionmanager.dat
		if (!this.mUseSSClosedWindowList && this.mPref_encrypt_sessions) {
			try { 
				this.mSecretDecoderRing.encryptString("");
			}
			catch(ex) {
				encrypt_okay = false;
				this.cryptError(this._string("decrypt_fail2"));
			}
		}
		
		if (encrypt_okay) {
			var badClosedWindowData = false;
			var closedWindows = this.getClosedWindows();
			closedWindows.forEach(function(aWindow, aIx) {
				// Try to decrypt is using sessionmanager.dat, if can't then data is bad since we checked for master password above
				var state = this.mUseSSClosedWindowList ? aWindow.state : this.decrypt(aWindow.state, true);
				if (!state && !this.mUseSSClosedWindowList) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = "crypt_error";
					return;
				}
				state = this.JSON_decode(state, true);
			
				// detect corrupt sessionmanager.dat file
				if (state._JSON_decode_failed && !this.mUseSSClosedWindowList) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = state._JSON_decode_error;
					return;
				}
			
				// Get favicon
				var image = defaultIcon;
				if (state.windows[0].tabs[0].xultab)
				{
					var xultabData = state.windows[0].tabs[0].xultab.split(" ");
					xultabData.forEach(function(bValue, bIndex) {
						var data = bValue.split("=");
						if (data[0] == "image") {
							image = data[1];
						}
					}, this);
				}
				// Firefox 3.5 uses attributes instead of xultab
				if (state.windows[0].tabs[0].attributes && state.windows[0].tabs[0].attributes.image)
				{
					image = state.windows[0].tabs[0].attributes.image;
				}
				// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
				// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
				// use the work around for https.
				if (/^https:/.test(image)) {
					image = "moz-anno:favicon:" + image;
				}
			
				// Get tab count
				var count = state.windows[0].tabs.length;
		
				var menuitem = document.createElement("menuitem");
				menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
				menuitem.setAttribute("label", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("index", "window" + aIx);
				menuitem.setAttribute("image", image);
				menuitem.setAttribute("oncommand", 'gSessionManager.undoCloseWindow(' + aIx + ', (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.ctrlKey || event.metaKey)?"append":"");');
				menuitem.setAttribute("onclick", 'gSessionManager.clickClosedUndoMenuItem(event);');
				menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
				menuitem.setAttribute("crop", "center");
				aPopup.insertBefore(menuitem, separator);
			}, this);
		
			// Remove any bad closed windows
			if (badClosedWindowData)
			{
				var error = null;
				for (var i=0; i < closedWindows.length; i++)
				{
					if (closedWindows[i]._decode_error)
					{
						error = closedWindows[i]._decode_error;
						closedWindows.splice(i, 1);
						this.storeClosedWindows_SM(closedWindows);
						// Do this so we don't skip over the next entry because of splice
						i--;
					}
				}
				if (error == "crypt_error") {
					this.cryptError(this._string("decrypt_fail1"));
				}
				else {
					this.sessionError(error);
				}
			}
		}
		
		label.hidden = !encrypt_okay || (closedWindows.length == 0);
		
		var listEnd = get_("end-separator");
		for (item = separator.nextSibling.nextSibling; item != listEnd; item = separator.nextSibling.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		var closedTabs = this.mSessionStore.getClosedTabData(window);
		var mClosedTabs = [];
		closedTabs = this.JSON_decode(closedTabs);
		closedTabs.forEach(function(aValue, aIndex) {
			mClosedTabs[aIndex] = { title:aValue.title, image:null, 
								url:aValue.state.entries[aValue.state.entries.length - 1].url }
			// Get favicon
			mClosedTabs[aIndex].image = defaultIcon;
			if (aValue.state.xultab)
			{
				var xultabData = aValue.state.xultab.split(" ");
				xultabData.forEach(function(bValue, bIndex) {
					var data = bValue.split("=");
					if (data[0] == "image") {
						mClosedTabs[aIndex].image = data[1];
					}
				}, this);
			}
			// Firefox 3.5 uses attributes instead of xultab
			if (aValue.state.attributes && aValue.state.attributes.image)
			{
				mClosedTabs[aIndex].image = aValue.state.attributes.image;
			}
			// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
			// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
			// use the work around for https.
			if (/^https:/.test(mClosedTabs[aIndex].image)) {
				mClosedTabs[aIndex].image = "moz-anno:favicon:" + mClosedTabs[aIndex].image;
			}
		}, this);

		mClosedTabs.forEach(function(aTab, aIx) {
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
			menuitem.setAttribute("image", aTab.image);
			menuitem.setAttribute("label", aTab.title);
			menuitem.setAttribute("index", "tab" + aIx);
			menuitem.setAttribute("statustext", aTab.url);
			menuitem.addEventListener("DOMMenuItemActive", function(event) { document.getElementById("statusbar-display").setAttribute("label",aTab.url); }, false);
			menuitem.addEventListener("DOMMenuItemInactive",  function(event) { document.getElementById("statusbar-display").setAttribute("label",''); }, false); 
			menuitem.setAttribute("oncommand", 'undoCloseTab(' + aIx + ');');
			menuitem.setAttribute("crop", "center");
			// Removing closed tabs does not work in SeaMonkey so don't give option to do so.
			if (this.mApplication.name != "SEAMONKEY") {
				menuitem.setAttribute("onclick", 'gSessionManager.clickClosedUndoMenuItem(event);');
				menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
			}
			aPopup.insertBefore(menuitem, listEnd);
		}, this);
		separator.nextSibling.hidden = (mClosedTabs.length == 0);
		separator.hidden = separator.nextSibling.hidden || label.hidden;
		
		var showPopup = closedWindows.length + mClosedTabs.length > 0;
		
		if (aStandAlone)
		{
			if (!showPopup)
			{
				this.updateToolbarButton(false);
				setTimeout(function(aPopup) { aPopup.parentNode.open = false; }, 0, aPopup);
			}
			else {
				// Bug copies tooltiptext to children so specifically set tooltiptext for all children
				this.fixBug374288(aPopup.parentNode);
			}
		}

		return showPopup;
	},

	undoCloseWindow: function(aIx, aMode)
	{
		var closedWindows = this.getClosedWindows();
		if (closedWindows[aIx || 0])
		{
			var state = closedWindows.splice(aIx || 0, 1)[0].state;
			
			// gSingleWindowMode is set if Tab Mix Plus's single window mode is active
			if (typeof(gSingleWindowMode) != "undefined" && gSingleWindowMode) aMode = "append";

			if (aMode == "overwrite")
			{
				this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
			}
			
			// If using SessionStore closed windows list and doing a normal restore, just use SessionStore API
			if (this.mUseSSClosedWindowList && (aMode != "append") && (aMode != "overwrite")) {
				this.mSessionStore.undoCloseWindow(aIx);
			}
			else {
				var okay = this.restoreSession((aMode == "overwrite" || aMode == "append")?window:null, state, aMode != "append");
				if (okay) {
					this.storeClosedWindows(closedWindows, aIx);
					this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
				}
			}
		}
	},

	clickClosedUndoMenuItem: function(aEvent) 
	{
		// if ctrl/command right click, remove item from list
		if ((aEvent.button == 2) && (aEvent.ctrlKey || aEvent.metaKey))
		{
			this.removeUndoMenuItem(aEvent.originalTarget);
			aEvent.preventDefault();
			aEvent.stopPropagation();
		}
	},
	
	removeUndoMenuItem: function(aTarget)
	{	
		var aIx = null;
		var indexAttribute = aTarget.getAttribute("index");
		// removing window item
		if (indexAttribute.indexOf("window") != -1) {
			// get index
			aIx = indexAttribute.substring(6);
			
			// remove window from closed window list and tell other open windows
			var closedWindows = this.getClosedWindows();
			closedWindows.splice(aIx, 1);
			this.storeClosedWindows(closedWindows, aIx);
			this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, closedWindows.length, "window");
		}
		// removing tab item
		else if (indexAttribute.indexOf("tab") != -1) {
			// get index
			aIx = indexAttribute.substring(3);
			
			// If Firefox bug 461634 is fixed use SessionStore method.
			if (typeof(this.mSessionStore.forgetClosedTab) != "undefined") {
				this.mSessionStore.forgetClosedTab(window, aIx);
			}
			else {
				// This code is based off of code in Tab Mix Plus
				var state = { windows: [], _firstTabs: true };

				// get closed-tabs from nsSessionStore
				var closedTabs = this.JSON_decode(this.mSessionStore.getClosedTabData(window));
				// purge closed tab at aIndex
				closedTabs.splice(aIx, 1);
				state.windows[0] = { _closedTabs : closedTabs };

				// replace existing _closedTabs
				this.mSessionStore.setWindowState(window, this.JSON_encode(state), false);
			}

			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			this.mSessionStore.setWindowValue(window, "SM_dummy_value","1");
			this.mSessionStore.deleteWindowValue(window, "SM_dummy_value");
			
			// update the remaining entries
			this.updateClosedList(aTarget, aIx, this.mSessionStore.getClosedTabCount(window), "tab");
		}
	},
	
	updateClosedList: function(aMenuItem, aIx, aClosedListLength, aType) 
	{
		// Get menu popup
		var popup = aMenuItem.parentNode;

		// remove item from list
		popup.removeChild(aMenuItem);
					
		// Update toolbar button if no more tabs
		if (aClosedListLength == 0) 
		{
			popup.hidePopup();
			this.mObserverService.notifyObservers(window, "sessionmanager:windowtabopenclose", aType);
		}
		// otherwise adjust indexes
		else 
		{
			for (var i=0; i<popup.childNodes.length; i++)
			{ 
				var index = popup.childNodes[i].getAttribute("index");
				if (index && index.substring(0,aType.length) == aType)
				{
					var indexNo = index.substring(aType.length);
					if (parseInt(indexNo) > parseInt(aIx))
					{
						popup.childNodes[i].setAttribute("index",aType + (parseInt(indexNo) - 1).toString());
					}
				}
			}
		}
	},

	clearUndoList: function()
	{
		var max_tabs_undo = this.getPref("browser.sessionstore.max_tabs_undo", 10, true);
		
		this.setPref("browser.sessionstore.max_tabs_undo", 0, true);
		this.setPref("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);
		// Check to see if the value was set correctly.  Tab Mix Plus will reset the max_tabs_undo preference 
		// to 10 when changing from 0 to any number.  See http://tmp.garyr.net/forum/viewtopic.php?t=10158
		if (this.getPref("browser.sessionstore.max_tabs_undo", 10, true) != max_tabs_undo) {
			this.setPref("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);
		}

		if (this.mUseSSClosedWindowList) {
			var state = { windows: [ {} ], _closedWindows: [] };
			this.mSessionStore.setWindowState(window, this.JSON_encode(state), false);
		}
		else {
			this.clearUndoData("window");
		}
		
		// the following forces SessionStore to save the state to disk which isn't done for some reason.
		this.mSessionStore.setWindowValue(window, "SM_dummy_value","1");
		this.mSessionStore.deleteWindowValue(window, "SM_dummy_value");
		
		this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
	},
	
/* ........ Right click menu handlers .............. */
	group_popupInit: function(aPopup) {
		var childMenu = document.popupNode.menupopup || document.popupNode.lastChild;
		childMenu.hidePopup();
	},
	
	group_rename: function() {
		var filename = document.popupNode.getAttribute("filename");
		var parentMenu = document.popupNode.parentNode.parentNode;
		var group = filename ? ((parentMenu.id != "sessionmanager-toolbar") ? parentMenu.label : "")
		                     : document.popupNode.getAttribute("label");
		var newgroup = { value: group };
		var dummy = {};
		this.mPromptService.prompt(window, this._string("rename_group"), null, newgroup, null, dummy);
		if (newgroup.value == this._string("backup_sessions")) {
			this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, this._string("rename_fail"));
			return;
		}
		else if (newgroup.value != group) {
			// changing group for one session or multiple sessions?
			if (filename) this.group(filename, newgroup.value);
			else {
				var sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (aSession.group == group) {
						this.group(aSession.fileName, newgroup.value);
					}
				}, this);
			}
		}
	},
	
	group_remove: function() {
		var group = document.popupNode.getAttribute("label");
		if (this.mPromptService.confirm(window, this.mTitle, this._string("delete_confirm_group"))) {
			
			var sessions = this.getSessions();
			var sessionsToDelete = [];
			sessions.forEach(function(aSession) {
				if (aSession.group == group) {
					sessionsToDelete.push(aSession.fileName);
				}
			}, this);
			if (sessionsToDelete.length) {
				sessionsToDelete = sessionsToDelete.join("\n");
				this.remove(sessionsToDelete);
			}
		}
	},

	session_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var current = (document.popupNode.getAttribute("disabled") == "true");
		var autosave = document.popupNode.getAttribute("autosave");
		var replace = get_("replace");
		
		replace.hidden = (this.getBrowserWindows().length == 1);
		
		// Disable saving in privacy mode or loaded auto-save session
		var inPrivateBrowsing = this.isPrivateBrowserMode();
		this.setDisabled(replace, (inPrivateBrowsing | current));
		this.setDisabled(get_("replacew"), (inPrivateBrowsing | current));
		
		// Disable almost everything for currently loaded auto-save session
		this.setDisabled(get_("loadaw"), current);
		this.setDisabled(get_("loada"), current);
		this.setDisabled(get_("loadr"), current);

		// Hide change group choice for backup items		
		get_("changegroup").hidden = (document.popupNode.getAttribute("backup-item") == "true")
		
		// Hide option to close or abandon sessions if they aren't loaded
		get_("closer").hidden = get_("abandon").hidden = !current || (autosave != "session");
		get_("closer_window").hidden = get_("abandon_window").hidden = !current || (autosave != "window");
		get_("close_separator").hidden = get_("closer").hidden && get_("closer_window").hidden;
		
		// Disable setting startup if already startup
		this.setDisabled(get_("startup"), ((this.mPref_startup == 2) && (document.popupNode.getAttribute("filename") == this.mPref_resume_session)));
		
		// If Tab Mix Plus's single window mode is enabled, hide options to load into new windows
		get_("loada").hidden = (typeof(gSingleWindowMode) != "undefined" && gSingleWindowMode);
	},

	session_close: function(aOneWindow, aAbandon) {
		if (aOneWindow) {
			var matchArray = /(\d\) )?(.*)   \(\d+\/\d+\)/.exec(document.popupNode.getAttribute("label"))
			if (matchArray && matchArray[2]) {
				var abandonBool = Components.classes["@mozilla.org/supports-PRBool;1"].createInstance(Components.interfaces.nsISupportsPRBool);
				abandonBool.data = (aAbandon == true);
				this.mObserverService.notifyObservers(abandonBool, "sessionmanager:close-windowsession", matchArray[2]);
			}
		}
		else {
			if (aAbandon) this.abandonSession();
			else this.closeSession();
		}
	},
	
	session_load: function(aReplace, aOneWindow) {
		var session = document.popupNode.getAttribute("filename");
		var oldOverwrite = this.mPref_overwrite;
		this.mPref_overwrite = !!aReplace;
		this.load(session, (aReplace?"overwrite":(aOneWindow?"append":"newwindow")));
		this.mPref_overwrite = oldOverwrite;
	},
	
	session_replace: function(aOneWindow) {
		var session = document.popupNode.getAttribute("filename");
		var parent = document.popupNode.parentNode.parentNode;
		var group = null;
		if (parent.id.indexOf("sessionmanager-") == -1) {
			group = parent.label;
		}
		if (aOneWindow) {
			this.saveWindow(this.getSessionCache(session).name, session, group);
		}
		else {
			this.save(this.getSessionCache(session).name, session, group);
		}
	},
	
	session_rename: function() {
		var session = document.popupNode.getAttribute("filename");
		this.rename(session);
	},

	session_remove: function() {
		var dontPrompt = { value: false };
		var session = document.popupNode.getAttribute("filename");
		if (this.getPref("no_delete_prompt") || this.mPromptService.confirmEx(window, this.mTitle, this._string("delete_confirm"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0) {
			this.remove(session);
			if (dontPrompt.value) {
				this.setPref("no_delete_prompt", true);
			}
		}
	},
	
	session_setStartup: function() {
		var session = document.popupNode.getAttribute("filename");
		this.setPref("resume_session", session);
		this.setPref("startup", 2);
	},
	
	hidePopup: function() {
		var popup = document.popupNode.parentNode;
		while (popup.parentNode.id.indexOf("sessionmanager-") == -1) {
			popup = popup.parentNode;
		}
		if (popup.parentNode.id != "sessionmanager-toolbar" ) popup = popup.parentNode.parentNode;
		popup.hidePopup();
	},
	
/* ........ User Prompts .............. */

	openSessionExplorer: function() {
		this.openWindow(
//			"chrome://sessionmanager/content/sessionexplorer.xul",
			"chrome://sessionmanager/content/places/places.xul",
			"chrome,titlebar,resizable,dialog=yes",
			{},
			(this.mFullyLoaded)?window:null
		);
	},

	prompt: function(aSessionLabel, aAcceptLabel, aValues, aTextLabel, aAcceptExistingLabel)
	{
		var params = Components.classes["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Components.interfaces.nsIDialogParamBlock);
		aValues = aValues || {};
		
		params.SetNumberStrings(8);
		params.SetString(1, aSessionLabel);
		params.SetString(2, aAcceptLabel);
		params.SetString(3, aValues.name || "");
		params.SetString(4, aTextLabel || "");
		params.SetString(5, aAcceptExistingLabel || "");
		params.SetString(6, aValues.text || "");
		params.SetString(7, aValues.count || "");
		params.SetInt(1, ((aValues.addCurrentSession)?1:0) | ((aValues.multiSelect)?2:0) | ((aValues.ignorable)?4:0) | 
						  ((aValues.autoSaveable)?8:0) | ((aValues.remove)?16:0) | ((aValues.grouping)?32:0) |
						  ((aValues.append_replace)?64:0) | ((aValues.preselect)?128:0) | ((aValues.allowNamedReplace)?256:0));
		
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,modal,resizable,dialog=yes", params, (this.mFullyLoaded)?window:null);
		
		aValues.name = params.GetString(3);
		aValues.text = params.GetString(6);
		aValues.group = params.GetString(7);
		aValues.ignore = (params.GetInt(1) & 4)?1:0;
		aValues.autoSave = (params.GetInt(1) & 8)?1:0;
		aValues.choseTabs = (params.GetInt(1) & 16)?1:0;
		aValues.append = (params.GetInt(1) & 32)?1:0;
		aValues.append_window = (params.GetInt(1) & 64)?1:0;
		aValues.autoSaveTime = params.GetInt(2) | null;
		return params.GetInt(0);
	},
	
	// the aOverride variable in an optional callback procedure that will be used to get the session list instead
	// of the default getSessions() function.  The function must return an array of sessions where a session is an
	// object containing:
	//		name 		- This is what is displayed in the session select window
	//		fileName	- This is what is returned when the object is selected
	//		windows		- Window count (optional - if omited won't display either window or tab count)
	//		tabs		- Tab count	(optional - if omited won't display either window or tab count)
	//		autosave	- Will cause item to be bold (optional)
	//      group       - Group that session is associated with (optional)
	//
	// If the session list is not formatted correctly a message will be displayed in the Error console
	// and the session select window will not be displayed.
	//
	selectSession: function(aSessionLabel, aAcceptLabel, aValues, aOverride)
	{
		var values = aValues || {};
		
		if (aOverride) this.getSessionsOverride = aOverride;
		
		if (this.prompt(aSessionLabel, aAcceptLabel, values))
		{
			this.getSessionsOverride = null;
			return values.name;
		}
		
		this.getSessionsOverride = null;
		return null;
	},

	ioError: function(aException)
	{
		this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, (this.mBundle)?this.mBundle.getFormattedString("io_error", [(aException)?aException.message:this._string("unknown_error")]):aException);
	},

	sessionError: function(aException)
	{
		this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, (this.mBundle)?this.mBundle.getFormattedString("session_error", [(aException)?aException.message:this._string("unknown_error")]):aException);
	},

	openWindow: function(aChromeURL, aFeatures, aArgument, aParent)
	{
		if (!aArgument || typeof aArgument == "string")
		{
			var argString = Components.classes["@mozilla.org/supports-string;1"].createInstance(Components.interfaces.nsISupportsString);
			argString.data = aArgument || "";
			aArgument = argString;
		}
		
		return Components.classes["@mozilla.org/embedcomp/window-watcher;1"].getService(Components.interfaces.nsIWindowWatcher).openWindow(aParent || null, aChromeURL, "_blank", aFeatures, aArgument);
	},

	clearUndoListPrompt: function()
	{
		var dontPrompt = { value: false };
		if (this.getPref("no_clear_list_prompt") || this.mPromptService.confirmEx(null, this.mTitle, this._string("clear_list_prompt"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			this.clearUndoList();
			if (dontPrompt.value)
			{
				this.setPref("no_clear_list_prompt", true);
			}
		}
	},
	
/* ........ File Handling .............. */
	convertToSQL: function() {
		// Open SQL file and connect to it
		var file = Components.classes["@mozilla.org/file/directory_service;1"]
		           .getService(Components.interfaces.nsIProperties)
		           .get("ProfD", Components.interfaces.nsIFile);
		file.append("sessionmanager.sqlite");
		this.delFile(file, true);

		// delete this after testing
		var date = new Date();
		var begin = date.getTime();
		
		var storageService = Components.classes["@mozilla.org/storage/service;1"]
		                     .getService(Components.interfaces.mozIStorageService);
		var mDBConn = storageService.openDatabase(file); 

		mDBConn.createTable("sessions", "filename TEXT PRIMARY KEY, name TEXT, groupname TEXT, timestamp INTEGER," +
		                     "autosave TEXT, windows INTEGER, tabs INTEGER, backup INTEGER, state BLOB");

		mDBConn.createTable("closed_windows", "id INTEGER PRIMARY KEY, name TEXT, state BLOB");
		
		var sessions = this.getSessions();

		var everythingOkay = true;
		mDBConn.beginTransaction();
		
		sessions.forEach(function(aSession) {
			
			if (everythingOkay) {
				var file = this.getSessionDir(aSession.fileName);
				var state = this.readSessionFile(file);
				if (state) 
				{
					if (this.mSessionRegExp.test(state))
					{
						state = state.split("\n")
					}
				}
				
				if (state[4]) {
					// Just replace whatever's there since the filename is unique
					var statement = mDBConn.createStatement(
						"INSERT INTO sessions (filename, name, groupname, timestamp, autosave, windows, tabs, backup, state) " +
						"VALUES ( :filename, :name, :groupname, :timestamp, :autosave, :windows, :tabs, :backup, :state )"
					);
					// need to wrap in older versions of Firefox
					if (this.mVersionCompare.compare(this.mApplication.version,"1.9.1a1pre") < 0) {
						var wrapper = Components.classes["@mozilla.org/storage/statement-wrapper;1"]
						              .createInstance(Components.interfaces.mozIStorageStatementWrapper);
						wrapper.initialize(statement);
						statement = wrapper;
					}
					statement.params.filename = aSession.fileName;
					statement.params.name = aSession.name;
					statement.params.groupname = aSession.group;
					statement.params.timestamp = aSession.timestamp;
					statement.params.autosave = aSession.autosave;
					statement.params.windows = aSession.windows;
					statement.params.tabs = aSession.tabs;
					statement.params.backup = aSession.backup ? 1 : 0;
					statement.params.state = state[4];
					try {
						statement.execute();
					}
					catch(ex) { 
						everythingOkay = false;
						this.log("convertToSQL: " + aSession.fileName + " - " + ex, "ERROR", true);
					}
					finally {
						if (this.mVersionCompare.compare(this.mApplication.version,"1.9.1a1pre") < 0) {
							statement.statement.finalize();
						}
						else {
							statement.finalize();
						}
					}
				}
			}
		}, this);

		var closedWindows = this.getClosedWindows_SM();
		closedWindows.forEach(function(aWindow) {
			var statement = mDBConn.createStatement("INSERT INTO closed_windows (name, state) VALUES (:name, :state)");
			// need to wrap in older versions of Firefox
			if (this.mVersionCompare.compare(this.mApplication.version,"1.9.1a1pre") < 0) {
				var wrapper = Components.classes["@mozilla.org/storage/statement-wrapper;1"]
				              .createInstance(Components.interfaces.mozIStorageStatementWrapper);
				statement = wrapper.initialize(statement);
			}
			statement.params.name = aWindow.name;
			statement.params.state = aWindow.state;
			try {
				statement.execute();
			}
			catch(ex) { 
				everythingOkay = false;
				this.log("convertToSQL" + aWindow.name + " - " + ex, "ERROR", true);
			}
			finally {
				if (this.mVersionCompare.compare(this.mApplication.version,"1.9.1a1pre") < 0) {
					statement.statement.finalize();
				}
				else {
					statement.finalize();
				}
			}
		});
		
		// if everything's good save everything, otherwise undo it
		if (everythingOkay) {
			mDBConn.commitTransaction();
			// delete this after testing
			var date = new Date();
			var end = date.getTime();
			Components.utils.reportError("Session Manager: Converted to SQL in " + (end - begin) + " ms");
		}
		else {
			mDBConn.rollbackTransaction();
			// delete this after testing
			Components.utils.reportError("Session Manager: Error converting to SQL");
		}
		mDBConn.close();
	},

	sanitize: function()
	{
		// If Sanitize GUI not used (or not Firefox 3.5 and above)
		if (this.mSanitizePreference == "privacy.item.extensions-sessionmanager") {
			// Remove all saved sessions
			this.getSessionDir().remove(true);
		}
		else {
			Components.classes["@mozilla.org/moz/jssubscript-loader;1"].getService(Components.interfaces.mozIJSSubScriptLoader)
			                                                           .loadSubScript("chrome://browser/content/sanitize.js");

			var range = Sanitizer.getClearRange();
		   
			// if delete all, then do it.
			if (!range) {
				// Remove all saved sessions
				this.getSessionDir().remove(true);
			}
			else {
				// Delete only sessions after startDate
				var sessions = this.getSessions();
				sessions.forEach(function(aSession, aIx) { 
					if (range[0] <= aSession.timestamp*1000) {
						this.delFile(this.getSessionDir(aSession.fileName));
					}
				}, this);
			}                 
		}
	},

	getProfileFile: function(aFileName)
	{
		var file = this.mProfileDirectory.clone();
		file.append(aFileName);
		return file;
	},
	
	getUserDir: function(aFileName)
	{
		var dir = null;
		var dirname = this.getPref("sessions_dir", "");
		try {
			if (dirname) {
				var dir = this.mComponents.classes["@mozilla.org/file/local;1"].createInstance(this.mComponents.interfaces.nsILocalFile);
				dir.initWithPath(dirname);
				if (dir.isDirectory && dir.isWritable()) {
					dir.append(aFileName);
				}
				else {
					dir = null;
				}
			}
		} catch (ex) {
			// handle the case on shutdown since the above will always throw an exception on shutdown
			if (this._mUserDirectory) dir = this._mUserDirectory.clone();
			else dir = null;
		} finally {
			return dir;
		}
	},

	getSessionDir: function(aFileName, aUnique)
	{
		// Check for absolute path first, session names can't have \ or / in them so this will work.  Relative paths will throw though.
		if (/[\\\/]/.test(aFileName)) {
			var file = this.mComponents.classes["@mozilla.org/file/local;1"].createInstance(this.mComponents.interfaces.nsILocalFile);
			try {
				file.initWithPath(aFileName);
			}
			catch(ex) {
				this.ioError(ex);
				file = null;
			}
			return file;
		}
		else {
			// allow overriding of location of sessions directory
			var dir = this.getUserDir("sessions");
			
			// use default is not specified or not a writable directory
			if (dir == null) {
				dir = this.getProfileFile("sessions");
			}
			if (!dir.exists())
			{
				try {
					dir.create(this.mComponents.interfaces.nsIFile.DIRECTORY_TYPE, 0700);
				}
				catch (ex) {
					this.ioError(ex);
					return null;
				}
			}
			if (aFileName)
			{
				dir.append(aFileName);
				if (aUnique)
				{
					var postfix = 1, ext = "";
					if (aFileName.slice(-this.mSessionExt.length) == this.mSessionExt)
					{
						aFileName = aFileName.slice(0, -this.mSessionExt.length);
						ext = this.mSessionExt;
					}
					while (dir.exists())
					{
						dir = dir.parent;
						dir.append(aFileName + "-" + (++postfix) + ext);
					}
				}
			}
			return dir.QueryInterface(this.mComponents.interfaces.nsILocalFile);
		}
	},

	//
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	//
	getSessions: function(filter)
	{
		var matchArray;
		var sessions = [];
		sessions.latestTime = sessions.latestBackUpTime = 0;
		
		var filesEnum = this.getSessionDir().directoryEntries.QueryInterface(this.mComponents.interfaces.nsISimpleEnumerator);
		while (filesEnum.hasMoreElements())
		{
			var file = filesEnum.getNext().QueryInterface(this.mComponents.interfaces.nsIFile);
			// don't try to read a directory
			if (file.isDirectory()) continue;
			var fileName = file.leafName;
			var backupItem = (this.mBackupSessionRegEx.test(fileName) || (fileName == this.mAutoSaveSessionName));
			var cached = this.getSessionCache(fileName) || null;
			if (cached && cached.time == file.lastModifiedTime)
			{
				try {
					if (filter && !filter.test(cached.name)) continue;
				} catch(ex) { 
					this.log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				if (!backupItem && (sessions.latestTime < cached.timestamp)) 
				{
					sessions.latestTime = cached.timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < cached.timestamp)) {
					sessions.latestBackUpTime = cached.timestamp;
				}
				sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp, autosave: cached.autosave, windows: cached.windows, tabs: cached.tabs, backup: backupItem, group: cached.group });
				continue;
			}
			if (matchArray = this.mSessionRegExp.exec(this.readSessionFile(file, true)))
			{
				try {
					if (filter && !filter.test(matchArray[1])) continue;
				} catch(ex) { 
					this.log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				var timestamp = parseInt(matchArray[2]) || file.lastModifiedTime;
				if (!backupItem && (sessions.latestTime < timestamp)) 
				{
					sessions.latestTime = timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < timestamp)) {
					sessions.latestBackUpTime = timestamp;
				}
				var group = matchArray[7] ? matchArray[7] : "";
				sessions.push({ fileName: fileName, name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group });
				// cache session data unless browser is shutting down
				if (!this.mPref__stopping) this.setSessionCache(fileName, { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group });
			}
		}
		
		if (!this.mPref_session_list_order)
		{
			this.mPref_session_list_order = this.getPref("session_list_order", 1);
		}
		switch (Math.abs(this.mPref_session_list_order))
		{
		case 1: // alphabetically
			sessions = sessions.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
			break;
		case 2: // chronologically
			sessions = sessions.sort(function(a, b) { return a.timestamp - b.timestamp; });
			break;
		}
		
		return (this.mPref_session_list_order < 0)?sessions.reverse():sessions;
	},

	getClosedWindowsCount: function() {
		return this.getClosedWindows(true);
	},
	
	// Get SessionStore's or Session Manager's Closed window List depending on preference.
	// Return the length if the Length Only parameter is true - only ever true if not using built in closed window list
	getClosedWindows: function(aLengthOnly)
	{
		if (this.mUseSSClosedWindowList) {
			var closedWindows = this.JSON_decode(this.mSessionStore.getClosedWindowData());
			if (aLengthOnly) return closedWindows.length;
			var parts = new Array(closedWindows.length);
			closedWindows.forEach(function(aWindow, aIx) {
				parts[aIx] = { name: aWindow.title, state: this.JSON_encode({windows:[aWindow]}) };
			}, this);
			return parts;
		}
		else {
			return this.getClosedWindows_SM(aLengthOnly);
		}
	},

	getClosedWindows_SM: function(aLengthOnly)
	{
		// Use cached data unless file has changed or was deleted
		var data = null;
		var file = this.getProfileFile(this.mClosedWindowFile);
		if (!file.exists()) return (aLengthOnly ? 0 : []);
		else if (file.lastModifiedTime > this.getClosedWindowCache(false)) {
			data = this.readFile(this.getProfileFile(this.mClosedWindowFile));
			this.setClosedWindowCache(data, file.lastModifiedTime);
			if (aLengthOnly) return (data ? data.split("\n\n").length : 0);
		}
		else {
			data = this.getClosedWindowCache(true, aLengthOnly);
			if (aLengthOnly) return data;
		}
		
		return (data)?data.split("\n\n").map(function(aEntry) {
			var parts = aEntry.split("\n");
			return { name: parts.shift(), state: parts.join("\n") };
		}):[];
	},

	// Stored closed windows into Session Store or Session Manager controller list.
	storeClosedWindows: function(aList, aIx)
	{
		if (this.mUseSSClosedWindowList) {
			// The following works in that the closed window appears to be removed from the list with no side effects
			var closedWindows = this.JSON_decode(this.mSessionStore.getClosedWindowData());
			closedWindows.splice(aIx || 0, 1);
			var state = { windows: [ {} ], _closedWindows: closedWindows };
			this.mSessionStore.setWindowState(window, this.JSON_encode(state), false);
			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			this.mSessionStore.setWindowValue(window, "SM_dummy_value","1");
			this.mSessionStore.deleteWindowValue(window, "SM_dummy_value");
		}
		else {
			this.storeClosedWindows_SM(aList);
		}
	},

	// Store closed windows into Session Manager controlled list
	storeClosedWindows_SM: function(aList)
	{
		var file = this.getProfileFile(this.mClosedWindowFile);
		if (aList.length > 0)
		{
			var data = aList.map(function(aEntry) {
				return aEntry.name + "\n" + aEntry.state
			}).join("\n\n");
			try {
				this.writeFile(file, data);
				this.setClosedWindowCache(data, file.lastModifiedTime);
			}
			catch(ex) {
				this.ioError(ex);
				return;
			}
		}
		else
		{
			try {
				this.delFile(file);
				this.setClosedWindowCache(null, 0);
			}
			catch(ex) {
				this.ioError(ex);
				return;
			}
		}
		
		this.updateToolbarButton(aList.length + this.mSessionStore.getClosedTabCount(window)  > 0);
	},

	appendClosedWindow: function(aState)
	{
		var cleanBrowser = (this.mCleanBrowser != null) ? this.mCleanBrowser : Array.every(gBrowser.browsers, this.isCleanBrowser);
		if (this.mPref_max_closed_undo == 0 || this.isPrivateBrowserMode() || cleanBrowser)
		{
			return;
		}
		
		var name = this.mClosedWindowName ? this.mClosedWindowName :
		           content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:this._string("untitled_window"));
		var windows = this.getClosedWindows_SM();
		
		// encrypt state if encryption preference set
		if (this.mPref_encrypt_sessions) {
			aState = this.decryptEncryptByPreference(aState);
			if (!aState) return;
		}
				
		aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
		windows.unshift({ name: name, state: aState });
		this.storeClosedWindows_SM(windows.slice(0, this.mPref_max_closed_undo));
	},

	clearUndoData: function(aType, aSilent, aShuttingDown)
	{
		if (aType == "window" || aType == "all")
		{
			this.delFile(this.getProfileFile(this.mClosedWindowFile), aSilent);
		}
		if (!aShuttingDown) this.updateToolbarButton((aType == "all")?false:undefined);
	},

	shutDown: function()
	{
		this.log("Shutdown start", "TRACE");
		// Handle sanitizing if sanitize on shutdown without prompting (Firefox 3.5 never prompts)
		var prompt = this.getPref("privacy.sanitize.promptOnSanitize", null, true);
		var sanitize = (this.getPref("privacy.sanitize.sanitizeOnShutdown", false, true) && 
		               (((prompt == false) && this.getPref("privacy.item.extensions-sessionmanager", false, true)) ||
		                ((prompt == null) && this.getPref("privacy.clearOnShutdown.extensions-sessionmanager", false, true))));

		if (sanitize)
		{
			this.sanitize();
		}
		// otherwise
		else
		{
			// If preference to clear save windows or using SessionStore closed windows, delete our closed window list
			if (!this.mPref_save_window_list || this.mUseSSClosedWindowList)
			{
				this.clearUndoData("window", true, true);
			}
			
			// Don't back up if in private browsing mode automatically via privacy preference
			var nobackup = this.mSMHelper.mAutoPrivacy && (this.mShutDownInPrivateBrowsingMode || this.isPrivateBrowserMode());
		
			// save the currently opened session (if there is one) otherwise backup if auto-private browsing mode not enabled
			if (!this.closeSession(false) && !nobackup)
			{
				this.backupCurrentSession();
			}
			else
			{
				this.keepOldBackups(false);
			}
			
			this.delFile(this.getSessionDir(this.mAutoSaveSessionName), true);
		}
		
		this.delPref("_autosave_values");
		this.delPref("_encrypt_file");
		this.delPref("_recovering");
		this.mLastState = null;
		this.mCleanBrowser = null;
		this.mClosedWindowName = null;

		// Cleanup left over files from Crash Recovery
		if (this.getPref("extensions.crashrecovery.resume_session_once", false, true))
		{	
			this.delFile(this.getProfileFile("crashrecovery.dat"), true);
			this.delFile(this.getProfileFile("crashrecovery.bak"), true);
			this.delPref("extensions.crashrecovery.resume_session_once", true);
		}
		this.setRunning(false);
		this.log("Shutdown end", "TRACE");
	},
	
	autoSaveCurrentSession: function(aForceSave)
	{
		try
		{
			if (aForceSave || !this.isPrivateBrowserMode()) {
				var state = this.getSessionState(this._string("autosave_session"), null, null, null, (this._string_backup_sessions || this._string("backup_sessions")));
				if (!state) return;
				this.writeFile(this.getSessionDir(this.mAutoSaveSessionName), state);
			}
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	},

	backupCurrentSession: function()
	{
		this.log("backupCurrentSession start", "TRACE");
		var backup = this.mPref_backup_session;
		var temp_backup = (this.mPref_startup > 0) && (this.mPref_resume_session == this.mBackupSessionName);
		// If shut down in private browsing mode, use the pre-private sesssion, otherwise get the current one
		var helper_state = (this.mShutDownInPrivateBrowsingMode || this.isPrivateBrowserMode()) ? this.mSMHelper.mBackupState : null;

		this.log("backupCurrentSession: backup = " + backup + ", temp_backup = " + temp_backup);
		this.log("helper_state = " + helper_state, "DATA");
		
		// Don't save if just a blank window, if there's an error parsing data, just save
		var state = null, lastState = null;
		if ((backup > 0) || temp_backup) {
			// if Last window state saved retrieve it in case the current state has been wiped and we need to use it
			// The current state should only be wiped if the browser is set to clear the "Visited Pages" on shutdown.
			if (this.mLastState) {
				this.log("backupCurrentSession: mLastState exists", "INFO");
				if (!helper_state) lastState = this.mLastState;
				this.mLastState = null;
			}
			try {
				state = this.getSessionState(this._string_backup_session || this._string("backup_session"), null, this.getNoUndoData(), null, (this._string_backup_sessions || this._string("backup_sessions")), true, null, helper_state);
			} catch(ex) {
				this.logError(ex);
			}
			try {
				var aState = this.JSON_decode(state.split("\n")[4]);
				// if window data has been cleared ("Visited Pages" cleared on shutdown), use lastState, if it exists.
				this.log("backupCurrentSession: Number of Windows #1 = " + aState.windows.length, "DATA");
				this.log(state, "STATE");
				if (aState.windows.length == 0 && lastState) {
					this.log("backupCurrentSession: Using saved Last State", "INFO");
					var count = this.getCount(lastState);
					state = state.split("\n");
					state[3] = state[3].replace(/count=0\/0/,"count=" + count.windows + "/" + count.tabs);
					state[4] = lastState;
					state = state.join("\n");
					aState = this.JSON_decode(lastState);
					this.log(lastState, "STATE");
				}
				this.log("backupCurrentSession: Number of Windows #2 = " + aState.windows.length, "DATA");
				if (!((aState.windows.length > 1) || (aState.windows[0]._closedTabs.length > 0) || (aState.windows[0].tabs.length > 1) || 
		    		(aState.windows[0].tabs[0].entries.length > 1) || 
		    		((aState.windows[0].tabs[0].entries.length == 1 && aState.windows[0].tabs[0].entries[0].url != "about:blank")))) {
					backup = 0;
					temp_backup = false;
				}
			} catch(ex) { 
				this.logError(ex);
			}
		}

		if (backup == 2)
		{
			var dontPrompt = { value: false };
			var saveRestore = !(this.getPref("browser.sessionstore.resume_session_once", false, true) || this.doResumeCurrent());
			var flags = this.mPromptService.BUTTON_TITLE_SAVE * this.mPromptService.BUTTON_POS_0 + 
			            this.mPromptService.BUTTON_TITLE_DONT_SAVE * this.mPromptService.BUTTON_POS_1 + 
			            (saveRestore ? (this.mPromptService.BUTTON_TITLE_IS_STRING * this.mPromptService.BUTTON_POS_2) : 0); 
			var results = this.mPromptService.confirmEx(null, this.mTitle, this._string_preserve_session || this._string("preserve_session"), flags,
			              null, null, this._string_save_and_restore || this._string("save_and_restore"),
			              this._string_prompt_not_again || this._string("prompt_not_again"), dontPrompt);
			backup = (results == 1)?-1:1;
			if (results == 2) {
				if (dontPrompt.value) {
					this.setPref("resume_session", this.mBackupSessionName);
					this.setPref("startup", 2);
				}
				else this.setPref("restore_temporary", true);
			}
			if (dontPrompt.value)
			{
				this.setPref("backup_session", (backup == -1)?0:1);
			}
		}
		if (backup > 0 || temp_backup)
		{
			this.keepOldBackups(backup > 0);
			
			// encrypt state if encryption preference set
			if (this.mPref_encrypt_sessions) {
				state = state.split("\n")
				state[4] = this.decryptEncryptByPreference(state[4]);
				if (!state[4]) return;
				state = state.join("\n");
			}
			
			try
			{
				this.writeFile(this.getSessionDir(this.mBackupSessionName), state);
				if (temp_backup && (backup <= 0)) this.setPref("backup_temporary", true);
			}
			catch (ex)
			{
				this.ioError(ex);
				this.logError(ex);
			}
		}
		else this.keepOldBackups(false);
		this.log("backupCurrentSession end", "TRACE");
	},

	keepOldBackups: function(backingUp)
	{
		if (!backingUp) this.mPref_max_backup_keep = this.mPref_max_backup_keep + 1; 
		var backup = this.getSessionDir(this.mBackupSessionName);
		if (backup.exists() && this.mPref_max_backup_keep)
		{
			var oldBackup = this.getSessionDir(this.mBackupSessionName, true);
			// preserve date that file was backed up
			var date = new Date();
			date.setTime(backup.lastModifiedTime); 
			var name = this.getFormattedName("", date, this._string_old_backup_session || this._string("old_backup_session"));
			this.writeFile(oldBackup, this.nameState(this.readSessionFile(backup), name));
			this.delFile(backup, true);
		}
		
		if (this.mPref_max_backup_keep != -1)
		{
			this.getSessions().filter(function(aSession) {
				return /^backup-\d+\.session$/.test(aSession.fileName);
			}).sort(function(a, b) {
				return b.timestamp - a.timestamp;
			}).slice(this.mPref_max_backup_keep).forEach(function(aSession) {
				this.delFile(this.getSessionDir(aSession.fileName), true);
			}, this);
		}
	},

	readSessionFile: function(aFile,headerOnly)
	{
		function getCountString(aCount) { 
			return "\tcount=" + aCount.windows + "/" + aCount.tabs + "\n"; 
		};

		var state = this.readFile(aFile,headerOnly);
		
		// old crashrecovery file format
		if ((/\n\[Window1\]\n/.test(state)) && 
			(/^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.test(state))) 
		{
			// read entire file if only read header
			var name = RegExp.$1 || this._string("untitled_window");
			var timestamp = parseInt(RegExp.$2) || aFile.lastModifiedTime;
			if (headerOnly) state = this.readFile(aFile);
			state = state.substring(state.indexOf("[Window1]\n"), state.length);
			state = this.JSON_encode(this.decodeOldFormat(state, true));
			state = state.substring(1,state.length-1);
			var countString = getCountString(this.getCount(state));
			state = "[SessionManager v2]\nname=" + name + "\ntimestamp=" + timestamp + "\nautosave=false" + countString + state;
			this.writeFile(aFile, state);
		}
		// Not latest session format
		else if ((/^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n/m.test(state)) && (!this.mSessionRegExp.test(state)))
		{
			// This should always match, but is required to get the RegExp values set correctly.
			// matchArray[0] - Entire 4 line header
			// matchArray[1] - Top 3 lines (includes name and timestamp)
			// matchArray[2] - " v2" (if it exists) - if missing file is in old format
			// matchArray[3] - Autosave string (if it exists)
			// matchArray[4] - Autosave value (not really used at the moment)
			// matchArray[5] - Count string (if it exists)
			// matchArray[6] - Group string and any invalid count string before (if either exists)
			// matchArray[7] - Invalid count string (if it exists)
			// matchArray[8] - Group string (if it exists)
			// matchArray[9] - Screen size string and, if no group string, any invalid count string before (if either exists)
			// matchArray[10] - Invalid count string (if it exists)
			// matchArray[11] - Screen size string (if it exists)
			var matchArray = /(^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n)(autosave=(false|true|session\/?\d*|window\/?\d*)[\n]?)?(\tcount=[1-9][0-9]*\/[1-9][0-9]*[\n]?)?((\t.*)?(\tgroup=[^\t|^\n|^\r]+[\n]?))?((\t.*)?(\tscreensize=\d+x\d+[\n]?))?/m.exec(state)
			if (matchArray)
			{	
				// If two autosave lines, session file is bad so try and fix it (shouldn't happen anymore)
				var goodSession = !/autosave=(false|true|session\/?\d*|window\/?\d*).*\nautosave=(false|true|session\/?\d*|window\/?\d*)/m.test(state);
				
				// read entire file if only read header
				if (headerOnly) state = this.readFile(aFile);

				if (goodSession)
				{
					var data = state.split("\n")[((matchArray[3]) ? 4 : 3)];
					var backup_data = data;
					data = this.decrypt(data, true, matchArray[2]);
					// If old format test JSON data
					if (!matchArray[2]) {
						matchArray[1] = matchArray[1].replace(/^\[SessionManager\]/, "[SessionManager v2]");
						var test_decode = this.JSON_decode(data, true);
						// if it failed to decode, try to decode again using new format
						if (test_decode._JSON_decode_failed) {
							data = this.decrypt(backup_data, true);
						}
					}
					backup_data = null;
					if (!data) {
						// master password entered, but still could not be encrypted - either corrupt or saved under different profile
						if (data == false) {
							this.moveToCorruptFolder(aFile);
						}
						return null;
					}
					var countString = (matchArray[5]) ? (matchArray[5]) : getCountString(this.getCount(data));
					// remove \n from count string if group or screen size is there
					if ((matchArray[8] || matchArray[11]) && (countString[countString.length-1] == "\n")) countString = countString.substring(0, countString.length - 1);
					var autoSaveString = (matchArray[3]) ? (matchArray[3]).split("\n")[0] : "autosave=false";
					if (autoSaveString == "autosave=true") autoSaveString = "autosave=session/";
					state = matchArray[1] + autoSaveString + countString + (matchArray[8] ? matchArray[8] : "") + (matchArray[11] ? matchArray[11] : "") + this.decryptEncryptByPreference(data);
					// bad session so rename it so it won't load again - This catches case where window and/or 
					// tab count is zero.  Technically we can load when tab count is 0, but that should never
					// happen so session is probably corrupted anyway so just flag it so.
					if (/(\d\/0)|(0\/\d)/.test(countString)) 
					{
						// If one window and no tabs (blank session), delete file otherwise mark it bad
						if (countString == "\tcount=1/0\n") {
							this.delFile(aFile, true);
							return null;
						}
						else {
							this.moveToCorruptFolder(aFile);
							return null;
						}
					}
					this.writeFile(aFile, state);
				}
				// else bad session format, attempt to recover by removing extra line
				else {
					var newstate = state.split("\n");
					newstate.splice(3,newstate.length - (newstate[newstate.length-1].length ? 5 : 6));
					if (RegExp.$6 == "\tcount=0/0") newstate.splice(3,1);
					state = newstate.join("\n");
					this.writeFile(aFile, state);
					state = this.readSessionFile(aFile,headerOnly);
				}
			}
		}
		
		return state;
	},
	
	readFile: function(aFile,headerOnly)
	{
		try
		{
			var stream = this.mComponents.classes["@mozilla.org/network/file-input-stream;1"].createInstance(this.mComponents.interfaces.nsIFileInputStream);
			stream.init(aFile, 0x01, 0, 0);
			var cvstream = this.mComponents.classes["@mozilla.org/intl/converter-input-stream;1"].createInstance(this.mComponents.interfaces.nsIConverterInputStream);
			cvstream.init(stream, "UTF-8", 1024, this.mComponents.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
			
			var content = "";
			var data = {};
			while (cvstream.readString(4096, data))
			{
				content += data.value;
				if (headerOnly) break;
			}
			cvstream.close();
			
			return content.replace(/\r\n?/g, "\n");
		}
		catch (ex) { }
		
		return null;
	},

	writeFile: function(aFile, aData)
	{
		if (!aData) return;  // this handles case where data could not be encrypted and null was passed to writeFile
		var stream = this.mComponents.classes["@mozilla.org/network/file-output-stream;1"].createInstance(this.mComponents.interfaces.nsIFileOutputStream);
		stream.init(aFile, 0x02 | 0x08 | 0x20, 0600, 0);
		var cvstream = this.mComponents.classes["@mozilla.org/intl/converter-output-stream;1"].createInstance(this.mComponents.interfaces.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, this.mComponents.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
		
		cvstream.writeString(aData.replace(/\n/g, this.mEOL));
		cvstream.flush();
		cvstream.close();
	},

	delFile: function(aFile, aSilent)
	{
		if (aFile && aFile.exists())
		{
			try
			{
				aFile.remove(false);
			}
			catch (ex)
			{
				if (!aSilent)
				{
					this.ioError(ex);
				}
			}
		}
	},
	
	moveToCorruptFolder: function(aFile, aSilent)
	{
		try {
			if (aFile.exists()) 
			{
				var dir = this.getSessionDir();
				dir.append("Corrupt_Sessions");
		
				if (!dir.exists()) {
					dir.create(this.mComponents.interfaces.nsIFile.DIRECTORY_TYPE, 0700);
				}
		
				aFile.moveTo(dir, null);
			}
		}	
		catch (ex) { 
			if (!aSilent) this.ioError(ex); 
		}
	},

/* ........ Encryption functions .............. */

	cryptError: function(aException, notSaved)
	{
		var text;
		if (aException.message) {
			if (aException.message.indexOf("decryptString") != -1) {
				if (aException.name != "NS_ERROR_NOT_AVAILABLE") {
					text = this._string("decrypt_fail1");
				}
				else {
					text = this._string("decrypt_fail2");
				}
			}
			else {
				text = notSaved ? (this._string_encrypt_fail2 || this._string("encrypt_fail2")) : (this._string_encrypt_fail || this._string("encrypt_fail"));
			}
		}
		else text = aException;
		this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, text);
	},

	decrypt: function(aData, aNoError, doNotDecode)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		if (aData.indexOf(":") == -1)
		{
			try {
				aData = this.mSecretDecoderRing.decryptString(aData);
				if (!doNotDecode) aData = decodeURIComponent(aData);
			}
			catch (ex) { 
				if (!aNoError) this.cryptError(ex); 
				// encrypted file corrupt, return false so as to not break things checking for aData.
				if (ex.name != "NS_ERROR_NOT_AVAILABLE") { 
					return false;
				}
				return null;
			}
		}
		return aData;
	},

	// This function will encrypt the data if the encryption preference is set.
	// It will also decrypt encrypted data if the encryption preference is not set.
	decryptEncryptByPreference: function(aData)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		var encrypted = (aData.indexOf(":") == -1);
		try {
			if (this.mPref_encrypt_sessions && !encrypted)
			{
				aData = this.mSecretDecoderRing.encryptString(encodeURIComponent(aData));
			}
			else if (!this.mPref_encrypt_sessions && encrypted)
			{
				aData = decodeURIComponent(this.mSecretDecoderRing.decryptString(aData));
			}
		}
		catch (ex) { 
			if (!encrypted && this.mPref_encrypted_only) {
				this.cryptError(ex, true);
				return null;
			}
			else this.cryptError(ex);
		}
		return aData;
	},

	encryptionChange: function()
	{
		try {
			// force a master password prompt so we don't waste time if user cancels it
			this.mSecretDecoderRing.encryptString("");
			
			var sessions = this.getSessions();
			sessions.forEach(function(aSession) {
				var file = this.getSessionDir(aSession.fileName);
				var state = this.readSessionFile(file);
				if (state) 
				{
					if (this.mSessionRegExp.test(state))
					{
						state = state.split("\n")
						state[4] = this.decryptEncryptByPreference(state[4]);
						state = state.join("\n");
						this.writeFile(file, state);
					}
				}
			}, this);
		
			if (!this.mUseSSClosedWindowList) {
				var windows = this.getClosedWindows_SM();
				windows.forEach(function(aWindow) {
					aWindow.state = this.decryptEncryptByPreference(aWindow.state);
				}, this);
				this.storeClosedWindows_SM(windows);
			}
		}
		// failed to encrypt/decrypt so revert setting
		catch (ex) {
			this.setPref("encrypt_sessions",!this.mPref_encrypt_sessions);
			this.cryptError(this._string("change_encryption_fail"));
		}
	},

/* ........ Conversion functions .............. */

	decodeOldFormat: function(aIniString, moveClosedTabs)
	{
		var rootObject = {};
		var obj = rootObject;
		var lines = aIniString.split("\n");
	
		for (var i = 0; i < lines.length; i++)
		{
			try
			{
				if (lines[i].charAt(0) == "[")
				{
					obj = this.ini_getObjForHeader(rootObject, lines[i]);
				}
				else if (lines[i] && lines[i].charAt(0) != ";")
				{
					this.ini_setValueForLine(obj, lines[i]);
				}
			}
			catch (ex)
			{
				throw new Error("Error at line " + (i + 1) + ": " + ex.description);
			}
		}
	
		// move the closed tabs to the right spot
		if (moveClosedTabs == true)
		{
			try
			{
				rootObject.windows.forEach(function(aValue, aIndex) {
					if (aValue.tabs && aValue.tabs[0]._closedTabs)
					{
						aValue["_closedTabs"] = aValue.tabs[0]._closedTabs;
						delete aValue.tabs[0]._closedTabs;
					}
				}, this);
			}
			catch (ex) {}
		}
	
		return rootObject;
	},

	ini_getObjForHeader: function(aObj, aLine)
	{
		var names = aLine.split("]")[0].substr(1).split(".");
	
		for (var i = 0; i < names.length; i++)
		{
			if (!names[i])
			{
				throw new Error("Invalid header: [" + names.join(".") + "]!");
			}
			if (/(\d+)$/.test(names[i]))
			{
				names[i] = names[i].slice(0, -RegExp.$1.length);
				var ix = parseInt(RegExp.$1) - 1;
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || [];
				aObj = aObj[ix] = aObj[ix] || {};
			}
			else
			{
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || {};
			}
		}
	
		return aObj;
	},

	ini_setValueForLine: function(aObj, aLine)
	{
		var ix = aLine.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aLine + "!");
		}
	
		var value = aLine.substr(ix + 1);
		if (value == "true" || value == "false")
		{
			value = (value == "true");
		}
		else if (/^\d+$/.test(value))
		{
			value = parseInt(value);
		}
		else if (value.indexOf("%") > -1)
		{
			value = decodeURI(value.replace(/%3B/gi, ";"));
		}
		
		var name = this.ini_fixName(aLine.substr(0, ix));
		if (name == "xultab")
		{
			//this.ini_parseCloseTabList(aObj, value);
		}
		else
		{
			aObj[name] = value;
		}
	},

	// This results in some kind of closed tab data being restored, but it is incomplete
	// as all closed tabs show up as "undefined" and they don't restore.  If someone
	// can fix this feel free, but since it is basically only used once I'm not going to bother.
	ini_parseCloseTabList: function(aObj, aCloseTabData)
	{
		var ClosedTabObject = {};
		var ix = aCloseTabData.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aCloseTabData + "!");
		}
		var serializedTabs = aCloseTabData.substr(ix + 1);
		serializedTabs = decodeURI(serializedTabs.replace(/%3B/gi, ";"));
		var closedTabs = serializedTabs.split("\f\f").map(function(aData) {
			if (/^(\d+) (.*)\n([\s\S]*)/.test(aData))
			{
				return { name: RegExp.$2, pos: parseInt(RegExp.$1), state: RegExp.$3 };
			}
			return null;
		}).filter(function(aTab) { return aTab != null; }).slice(0, this.getPref("browser.sessionstore.max_tabs_undo", 10, true));

		closedTabs.forEach(function(aValue, aIndex) {
			closedTabs[aIndex] = this.decodeOldFormat(aValue.state, false)
			closedTabs[aIndex] = closedTabs[aIndex].windows;
			closedTabs[aIndex] = closedTabs[aIndex][0].tabs;
		}, this);

		aObj["_closedTabs"] = [];

		closedTabs.forEach(function(aValue, aIndex) {
			aObj["_closedTabs"][aIndex] = this.JSON_decode({ state : this.JSON_encode(aValue[0]) });
		}, this);
	},

	ini_fixName: function(aName)
	{
		switch (aName)
		{
			case "Window":
				return "windows";
			case "Tab":
				return "tabs";
			case "Entry":
				return "entries";
			case "Child":
				return "children";
			case "Cookies":
				return "cookies";
			case "uri":
				return "url";
			default:
				return aName;
		}			
	},

/* ........ Preference Access .............. */

	// Certain preferences should be force saved in case of a crash
	checkForForceSave: function(aName, aValue, aUseRootBranch)
	{
		var names = [ "_autosave_values" ];
		
		for (var i=0; i<names.length; i++) {
			if (aName == names[i]) {
				var currentValue = this.getPref(aName, null, aUseRootBranch);
				return (currentValue != aValue);
			}
		}
		return false;
	},
		

	getPref: function(aName, aDefault, aUseRootBranch)
	{
		try
		{
			var pb = (aUseRootBranch)?this.mPrefRoot:this.mPrefBranch;
			switch (pb.getPrefType(aName))
			{
				case pb.PREF_STRING:
					//return pb.getCharPref(aName);
					// handle unicode values
					return pb.getComplexValue(aName,this.mComponents.interfaces.nsISupportsString).data
				case pb.PREF_BOOL:
					return pb.getBoolPref(aName);
				case pb.PREF_INT:
					return pb.getIntPref(aName);
			}
		}
		catch (ex) { }
		
		return aDefault;
	},

	setPref: function(aName, aValue, aUseRootBranch)
	{
		var forceSave = this.checkForForceSave(aName, aValue, aUseRootBranch);
		
		var pb = (aUseRootBranch)?this.mPrefRoot:this.mPrefBranch;
		switch (typeof aValue)
		{
		case "boolean":
			pb.setBoolPref(aName, aValue);
			break;
		case "number":
			pb.setIntPref(aName, parseInt(aValue));
			break;
		default:
			//pb.setCharPref(aName, "" + aValue);
			// Handle unicode preferences
			var str = this.mComponents.classes["@mozilla.org/supports-string;1"].createInstance(this.mComponents.interfaces.nsISupportsString);
			str.data = aValue;
			pb.setComplexValue(aName,this.mComponents.interfaces.nsISupportsString, str);

			break;
		}
		
		if (forceSave) this.mObserverService.notifyObservers(null,"sessionmanager-preference-save",null);
	},

	delPref: function(aName, aUseRootBranch)
	{
		((aUseRootBranch)?this.mPrefRoot:this.mPrefBranch).deleteBranch(aName);
	},

/* ........ Miscellaneous Enhancements .............. */

	// Check for Running
	isRunning: function() {
		return this.mApplication.storage.get("sessionmanager._running", false);
	},
	
	// Check for Running
	setRunning: function(aValue) {
		return this.mApplication.storage.set("sessionmanager._running", aValue);
	},

	// Caching functions
	getSessionCache: function(aName) {
		return this.mApplication.storage.get(this.mSessionCache + aName, null);
	},
	
	setSessionCache: function(aName, aData) {
		this.mApplication.storage.set(this.mSessionCache + aName, aData);
	},
	
	getClosedWindowCache: function(aData, aLengthOnly) {
		if (aData && aLengthOnly) {
			return this.mApplication.storage.get(this.mClosedWindowsCacheLength, 0);
		}
		else if (aData) {
			return this.mApplication.storage.get(this.mClosedWindowsCacheData, null);
		}
		else {
			return this.mApplication.storage.get(this.mClosedWindowsCacheTimestamp, 0);
		}
	},

	setClosedWindowCache: function(aData, aTimestamp) {
		this.mApplication.storage.set(this.mClosedWindowsCacheData, aData);
		this.mApplication.storage.set(this.mClosedWindowsCacheTimestamp, (aData ? aTimestamp : 0));
		this.mApplication.storage.set(this.mClosedWindowsCacheLength, (aData ? aData.split("\n\n").length : 0));
	},
	
	// Read Autosave values from preference and store into global variables
	getAutoSaveValues: function(aValues, aOneWindow)
	{
		if (!aValues) aValues = "";
		this.log("getAutoSaveValues: aOneWindow = " + aOneWindow + ", aValues = " + aValues.split("\n").join(", "), "EXTRA");
		var values = aValues.split("\n");
		if (aOneWindow) {
			var old_window_session_name = this.__window_session_name;
			this.__window_session_name = values[0];
			this.__window_session_group = values[1];
			this.__window_session_time = (!values[2] || isNaN(values[2])) ? 0 : values[2];
			try {
				var windowSessions = this.mApplication.storage.get(this.mActiveWindowSessions, {});
				// This throws whenever a window is already closed (during shutdown for example) or if the value doesn't exist and we try to delete it
				if (aValues) {
					// Store window session into Application storage and set window value
					windowSessions[values[0].trim().toLowerCase()] = true;
					this.mApplication.storage.set(this.mActiveWindowSessions, windowSessions);
					this.mSessionStore.setWindowValue(window, "_sm_window_session_values", aValues);
				}
				else {
					if (old_window_session_name) {
						// Remove window session from Application storage and delete window value
						delete windowSessions[old_window_session_name.trim().toLowerCase()];
						this.mApplication.storage.set(this.mActiveWindowSessions, windowSessions);
					}
					this.mSessionStore.deleteWindowValue(window, "_sm_window_session_values");
					
					// the following forces SessionStore to save the state to disk (bug 510965)
					// Can't just set _sm_window_session_values to "" and then delete since that will throw an exception
					this.mSessionStore.setWindowValue(window, "SM_dummy_value","1");
					this.mSessionStore.deleteWindowValue(window, "SM_dummy_value");
				}
			}
			catch(ex) {
				// log it so we can tell when things aren't working
				this.logError(ex);
			}
			
			// start/stop window timer
			this.checkWinTimer();
			gBrowser.updateTitlebar();
		}
		else {
			this.mPref__autosave_name = values[0];
			this.mPref__autosave_group = values[1];
			this.mPref__autosave_time = (!values[2] || isNaN(values[2])) ? 0 : values[2];
		}
	},

	// Merge autosave variables into a a string
	mergeAutoSaveValues: function(name, group, time)
	{
		var values = [ name, group, time ];
		return values.join("\n");
	},
	
	// Bug 374288 causes all elements that don't have a specified tooltip or tooltiptext to inherit their
	// ancestors tooltip/tooltiptext.  To work around this set a blank tooltiptext for all descendents of aNode.
	//
	fixBug374288: function(aNode)
	{
		if (aNode && aNode.childNodes) {
			for (var i in aNode.childNodes) {
				var child = aNode.childNodes[i];
				if (child && child.getAttribute && !child.getAttribute("tooltiptext")) {
					child.setAttribute("tooltiptext", "");
				}
				this.fixBug374288(child);
			}
		}
	},

	// Called to handle clearing of private data (stored sessions) when the toolbar item is selected
	// and when the clear now button is pressed in the privacy options pane.  If the option to promptOnSanitize
	// is set, this function ignores the request and let's the Firefox Sanitize function call
	// gSessionManager.santize when Clear Private Data okay button is pressed and Session Manager's checkbox
	// is selected.
	tryToSanitize: function()
	{
		// User disabled the prompt before clear option and session manager is checked in the privacy data settings
		if ( !this.getPref("privacy.sanitize.promptOnSanitize", true, true) &&
			 this.getPref("privacy.item.extensions-sessionmanager", false, true) ) 
		{
			this.sanitize();
			return true;
		}
	
		return false;
	},
		
	recoverSession: function()
	{
		var file, temp_restore = null, first_temp_restore = null, temp_restore_index = 1;
		var recovering = this.getPref("_recovering");
		// Use SessionStart's value in FF3 because preference is cleared by the time we are called
		var sessionstart = (this.mSessionStartup.sessionType != Components.interfaces.nsISessionStartup.NO_SESSION) && !this.mApplication.storage.get(this.mAlreadyShutdown, false);
		var recoverOnly = this.isRunning() || sessionstart || this.getPref("_no_prompt_for_session", false);
		this.delPref("_no_prompt_for_session");
		this.log("recoverSession: recovering = " + recovering + ", sessionstart = " + sessionstart + ", recoverOnly = " + recoverOnly, "DATA");
		if (typeof(this._temp_restore) == "string") {
			this.log("recoverSession: command line session data = \"" + this._temp_restore + "\"", "DATA");
			temp_restore = this._temp_restore.split("\n");
			first_temp_restore = temp_restore[1];
		}
		this._temp_restore = null;

		// handle crash where user chose a specific session
		if (recovering)
		{
			var choseTabs = false;
			choseTabs = this.getPref("_chose_tabs");
			this.delPref("_recovering");
			this.delPref("_chose_tabs"); // delete chose tabs preference if set
			this.load(recovering, "startup", choseTabs);
		}
		else if (!recoverOnly && (this.mPref_restore_temporary || first_temp_restore || (this.mPref_startup == 1) || ((this.mPref_startup == 2) && this.mPref_resume_session)) && this.getSessions().length > 0)
		{
			// allow prompting for tabs in Firefox 3.5
			var values = { ignorable: true, preselect: this.mPref_preselect_previous_session };
			
			// Order preference:
			// 1. Temporary backup session
			// 2. Prompt or selected session
			// 3. Command line session.
			var session = (this.mPref_restore_temporary)?this.mBackupSessionName:((this.mPref_startup == 1)?this.selectSession(this._string("resume_session"), this._string("resume_session_ok"), values):
			              ((this.mPref_startup == 2)?this.mPref_resume_session:first_temp_restore));
			// If no session chosen to restore, use the command line specified session
			if (!session) session = first_temp_restore;
			if (session && (session == first_temp_restore)) {
				this.log("recoverSession: Restoring startup command line session \"" + first_temp_restore + "\"", "DATA");
				// Go to next command line item if it exists
				temp_restore_index++;
			}
			this.log("recoverSession: Startup session = " + session, "DATA");
			if ((session) && (file = this.getSessionDir(session)) && file.exists())
			{
				this.load(session, "startup", values.choseTabs);
			}
			// if user set to resume previous session, don't clear this so that way user can choose whether to backup
			// current session or not and still have it restore.
			else if ((this.mPref_startup == 2) && (this.mPref_resume_session != this.mBackupSessionName)) {
				this.setPref("resume_session",this.mBackupSessionName);
				this.setPref("startup",0);
			}
			if (values.ignore)
			{
				this.setPref("resume_session", session || this.mBackupSessionName);
				this.setPref("startup", (session)?2:0);
			}
			// Display Home Page if user selected to do so
			//if (display home page && this.isCmdLineEmpty()) {
			//	BrowserHome();
			//}
		}
		// handle browser reload with same session and when opening new windows
		else if (recoverOnly) {
			this.checkTimer();
		}
		
		// Restore command line specified session(s) in a new window if they haven't been restored already
		if (first_temp_restore) {
			// For each remaining session in the command line
			while (temp_restore.length > temp_restore_index) {
				file = this.getSessionDir(temp_restore[temp_restore_index]);
				this.log(file.path);
				if (file && file.exists()) {
					this.log("recoverSession: Restoring additional command line session " + temp_restore_index + " \"" + temp_restore[temp_restore_index] + "\"", "DATA");
					// Only restore into existing window if not startup and first session in command line
					this.load(temp_restore[temp_restore_index], (((temp_restore_index > 1) || (temp_restore[0] == "0")) ? "newwindow_always" : "overwrite_window"));
				}
				temp_restore_index++;
			}
		}
		
		// If need to encrypt backup file, do it
		var backupFile = this.getPref("_encrypt_file");
		if (backupFile) {
			this.delPref("_encrypt_file");
			var file = this.getSessionDir(backupFile);
			var state = this.readSessionFile(file);
			if (state) 
			{
				if (this.mSessionRegExp.test(state))
				{
					state = state.split("\n")
					state[4] = this.decryptEncryptByPreference(state[4]);
					// if could be encrypted or encryption failed but user allows unencrypted sessions
					if (state[4]) {
						// if encrypted save it
						if (state[4].indexOf(":") == -1) {
							state = state.join("\n");
							this.writeFile(file, state);
						}
					}
					// couldn't encrypt and user does not want unencrypted files so delete it
					else this.delFile(file);
				}
				else this.delFile(file);
			}
		}
	},

	isCmdLineEmpty: function()
	{
		if (this.mApplication.name != "SEAMONKEY") {
			try {
				// Use the defaultArgs, unless SessionStore was trying to resume or handle a crash.
				// This handles the case where the browser updated and SessionStore thought it was supposed to display the update page, so make sure we don't overwrite it.
				var defaultArgs = (this.mSessionStartup.sessionType != Components.interfaces.nsISessionStartup.NO_SESSION) ? 
				                  Components.classes["@mozilla.org/browser/clh;1"].getService(Components.interfaces.nsIBrowserHandler).startPage :
				                  Components.classes["@mozilla.org/browser/clh;1"].getService(Components.interfaces.nsIBrowserHandler).defaultArgs;
				if (window.arguments && window.arguments[0] && window.arguments[0] == defaultArgs) {
					window.arguments[0] = null;
				}
				return !window.arguments || !window.arguments[0];
			}
			catch(ex) {
				this.logError(ex);
				return false;
			}
		}
		else {
			var startPage = "about:blank";
			if (this.getPref("browser.startup.page", 1, true) == 1) {
				startPage = this.SeaMonkey_getHomePageGroup();
			}
			return "arguments" in window && window.arguments.length && (window.arguments[0] == startPage);
		}
	},

	SeaMonkey_getHomePageGroup: function()
	{
		var homePage = this.mPrefRoot.getComplexValue("browser.startup.homepage", Components.interfaces.nsIPrefLocalizedString).data;
		var count = this.getPref("browser.startup.homepage.count", 0, true);

		for (var i = 1; i < count; ++i) {
			homePage += '\n' + this.getPref("browser.startup.homepage." + i, "", true);
		}
		return homePage;
	},
	
	// Return private browsing mode (PBM) state - If user choose to allow saving in PBM and encryption
	// is enabled, return false.
	isPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox 3.5 and above
		if (this.mPrivateBrowsing) {
			if (this.mPref_enable_saving_in_private_browsing_mode && this.mPref_encrypt_sessions) {
				return false;
			}
			else {
				return this.mPrivateBrowsing.privateBrowsingEnabled;
			}
		}
		else {
			return false;
		}
	},

	isAutoStartPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox 3.5 and above
		if (this.mPrivateBrowsing) {
			return this.mPrivateBrowsing.autoStarted;
		}
		else {
			return false;
		}
	},

	updateToolbarButton: function(aEnable)
	{
		var button = (document)?document.getElementById("sessionmanager-undo"):null;
		if (button)
		{
			var tabcount = 0;
			var wincount = 0;
			try {
				wincount = this.mUseSSClosedWindowList ? this.mSessionStore.getClosedWindowCount() : this.getClosedWindowsCount();
				tabcount = this.mSessionStore.getClosedTabCount(window);
			} catch (ex) { this.logError(ex); }
			this.setDisabled(button, (aEnable != undefined)?!aEnable:tabcount == 0 && wincount == 0);
		}
	},
	
	showHideToolsMenu: function()
	{
		var sessionMenu = document.getElementById("sessionmanager-menu");
		if (sessionMenu) sessionMenu.hidden = this.mPref_hide_tools_menu;
	},

	checkTimer: function()
	{
		// only act if timer already started
		if (this._timer && ((this.mPref__autosave_time <= 0) || !this.mPref__autosave_name)) {
			this._timer.cancel();
			this._timer = null;
			this.log("checkTimer: Session Timer stopped", "INFO");
		}
		else if (!this._timer && (this.mPref__autosave_time > 0) && this.mPref__autosave_name) {
			this.log("checkTimer: Check if session timer already running and if not start it", "INFO");
			var allWindows = this.getBrowserWindows();
			var timerRunning = false;
			for (var i in allWindows) {
				if (allWindows[i].gSessionManager._timer) {
					timerRunning = true;
					break;
				}
			}
			if (!timerRunning) {
				this._timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
				this._timer.init(gSessionManager, this.mPref__autosave_time * 60000, Ci.nsITimer.TYPE_REPEATING_PRECISE);
				this.log("checkTimer: Session Timer started for " + this.mPref__autosave_time + " minutes", "INFO");
			}
		}
	},
	
	checkWinTimer: function()
	{
		// only act if timer already started
		if ((this._win_timer && ((this.__window_session_time <=0) || !this.__window_session_name))) {
			this._win_timer.cancel();
			this._win_timer = null;
			this.log("checkWinTimer: Window Timer stopped", "INFO");
		}
		else if (!this._win_timer && (this.__window_session_time > 0) && this.__window_session_name) {
			this._win_timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
			this._win_timer.init(gSessionManager, this.__window_session_time * 60000, Ci.nsITimer.TYPE_REPEATING_PRECISE);
			this.log("checkWinTimer: Window Timer started for " + this.__window_session_time + " minutes", "INFO");
		}
	},
	
/* ........ Auxiliary Functions .............. */
	// Undo closed tab function for SeaMonkey
	undoCloseTabSM: function(aIndex)
	{
		if (gSessionManager.mSessionStore.getClosedTabCount(window) == 0)	return;
		gSessionManager.mSessionStore.undoCloseTab(window, aIndex || 0);
		// Only need to check for empty close tab list if possibly re-opening last closed tabs
		if (!aIndex) gSessionManager.updateToolbarButton();
	},
	
	getNoUndoData: function(aLoad, aMode)
	{
		return aLoad ? { tabs: (!this.mPref_save_closed_tabs || (this.mPref_save_closed_tabs == 1 && (aMode != "startup"))),
		                 windows: (!this.mPref_save_closed_windows || (this.mPref_save_closed_windows == 1 && (aMode != "startup"))) }
		             : { tabs: (this.mPref_save_closed_tabs < 2), windows: (this.mPref_save_closed_windows < 2) };
	},

	// count windows and tabs
	getCount: function(aState)
	{
		var windows = 0, tabs = 0;
		
		try {
			var state = this.JSON_decode(aState);
			state.windows.forEach(function(aWindow) {
				windows = windows + 1;
				tabs = tabs + aWindow.tabs.length;
			});
		}
		catch (ex) { this.logError(ex); };

		return { windows: windows, tabs: tabs };
	},
	
	getSessionState: function(aName, aOneWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime, aState)
	{
		// Return last closed window state if it is stored.
		if (this.mLastState) {
			this.log("getSessionState: Returning stored state", "INFO");
			// encrypt state if encryption preference set
			if (!aDoNotEncrypt) {
				var state = this.mLastState.split("\n")
				// if there is a state[4] it's a session otherwise it's a closed window
				if (state[4]) {
					state[4] = this.decryptEncryptByPreference(state[4]);
					if (!state[4]) return null;
				}
				else {
					state[0] = this.decryptEncryptByPreference(state[0]);
					if (!state[0]) return null;
				}
				this.mLastState = state.join("\n");
			}
			return this.mLastState;
		}
		
		// Use passed in State if specified, otherwise grab the current one.  Used for saving old state when shut down in 
		// private browsing mode
		try {
			var state = (aState) ? aState : (aOneWindow)?this.mSessionStore.getWindowState(window):this.mSessionStore.getBrowserState();
		}
		catch(ex) {
			// Log and rethrow errors
			this.logError(ex);
			throw(ex);
		}
		
		state = this.modifySessionData(state, aNoUndoData, true);
		var count = this.getCount(state);
		
		// encrypt state if encryption preference set and flag not set
		if (!aDoNotEncrypt) {
			state = this.decryptEncryptByPreference(state); 
			if (!state) return null;
		}
		
		return (aName != null)?this.nameState(("[SessionManager v2]\nname=" + (new Date()).toString() + "\ntimestamp=" + Date.now() + 
				"\nautosave=" + ((aAutoSave)?aOneWindow?("window/" + aAutoSaveTime):("session/" + aAutoSaveTime):"false") + "\tcount=" + count.windows + "/" + count.tabs + 
				(aGroup? ("\tgroup=" + aGroup.replace(/\t/g, " ")) : "") + "\tscreensize=" + (this._screen_width || screen.width) + "x" + (this._screen_height || screen.height) + 
				"\n" + state + "\n").replace(/\n\[/g, "\n$&"), aName.replace(/\t/g, " ") || ""):state;
	},

	restoreSession: function(aWindow, aState, aReplaceTabs, aNoUndoData, aEntireSession, aOneWindow, aStartup, aWindowSessionValues, xDelta, yDelta)
	{
		this.log("restoreSession: aWindow = " + aWindow + ", aReplaceTabs = " + aReplaceTabs + ", aNoUndoData = " + (aNoUndoData ? this.mNativeJSON.encode(aNoUndoData) : "undefined") + 
		         ", aEntireSession = " + aEntireSession + ", aOneWindow = " + aOneWindow + ", aStartup = " + aStartup + 
				 ", aWindowSessionValues = " + (aWindowSessionValues ? ("\"" + aWindowSessionValues.split("\n").join(", ") + "\"") : "undefined") + ", xDelta = " + xDelta + ", yDelta = " + yDelta, "DATA");
		// decrypt state if encrypted
		aState = this.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = this.openWindow(this.getPref("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				this.gSessionManager.restoreSession(this, aState, aReplaceTabs, aNoUndoData, null, null, null, aWindowSessionValues, xDelta, yDelta);
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		aState = this.modifySessionData(aState, aNoUndoData, false, aEntireSession, aStartup, xDelta, yDelta);  

		if (aEntireSession)
		{
			this.mSessionStore.setBrowserState(aState);
		}
		else
		{
			if (aOneWindow) aState = this.makeOneWindow(aState);
			this.mSessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
		}
		
		// Store autosave values into window value and also into window variables
		if (!this.__window_session_name) this.getAutoSaveValues(aWindowSessionValues, true);
		this.log("restoreSession: restore done, window_name  = " + this.__window_session_name, "DATA");
		return true;
	},

	nameState: function(aState, aName)
	{
		if (!/^\[SessionManager v2\]/m.test(aState))
		{
			return "[SessionManager v2]\nname=" + aName.replace(/\t/g, " ") + "\n" + aState;
		}
		return aState.replace(/^(\[SessionManager v2\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName.replace(/\t/g, " "); });
	},
	
	makeOneWindow: function(aState)
	{
		aState = this.JSON_decode(aState);
		if (aState.windows.length > 1)
		{
			// take off first window
			var firstWindow = aState.windows.shift();
			// make sure toolbars are not hidden on the window
			delete(firstWindow.hidden);
			// Move tabs to first window
			aState.windows.forEach(function(aWindow) {
				while (aWindow.tabs.length > 0)
				{
					this.tabs.push(aWindow.tabs.shift());
				}
			}, firstWindow);
			// Remove all but first window
			aState.windows = [];
			aState.windows[0] = firstWindow;
		}
		return this.JSON_encode(aState);
	},
	
	modifySessionData: function(aState, aNoUndoData, aSaving, aReplacingWindow, aStartup, xDelta, yDelta)
	{
		if (!xDelta) xDelta = 1;
		if (!yDelta) yDelta = 1;
	
		// Don't do anything if not modifying session data
		if (!(aNoUndoData || aSaving || aReplacingWindow || aStartup || (xDelta != 1) || (yDelta != 1))) {
			return aState;
		}
		aState = this.JSON_decode(aState);
		
		// set _firsttabs to true on startup to prevent closed tabs list from clearing when not overwriting tabs.
		if (aStartup) aState._firstTabs = true;
		
		var fixWindow = function(aWindow) {
			// Strip out cookies if user doesn't want to save them
			if (aSaving && !this.mPref_save_cookies) delete(aWindow.cookies);

			// remove closed tabs			
			if (aNoUndoData && aNoUndoData.tabs) aWindow._closedTabs = [];
			
			// adjust window position and height if screen dimensions don't match saved screen dimensions
			aWindow.width = aWindow.width * xDelta;
			aWindow.height = aWindow.height * yDelta;
			aWindow.screenX = aWindow.screenX * xDelta;
			aWindow.screenY = aWindow.screenY * yDelta;
		};
		
		// process opened windows
		aState.windows.forEach(fixWindow, this);
		
		// process closed windows (for sessions only)
		if (aState._closedWindows) {
			if (this.mUseSSClosedWindowList && aNoUndoData && aNoUndoData.windows) {
				aState._closedWindows = [];
			}
			else  {
				aState._closedWindows.forEach(fixWindow, this);
			}
		}

		// if only one window, don't allow toolbars to be hidden
		if (aReplacingWindow && (aState.windows.length == 1) && aState.windows[0].hidden) {
			delete (aState.windows[0].hidden);
		}
		return this.JSON_encode(aState);
	},

	getFormattedName: function(aTitle, aDate, aFormat)
	{
		function cut(aString, aLength)
		{
			return aString.replace(new RegExp("^(.{" + (aLength - 3) + "}).{4,}$"), "$1...");
		}
		function toISO8601(aDate, format)
		{
			if (format) {
				return aDate.toLocaleFormat(format);
			}
			else {
				return [aDate.getFullYear(), pad2(aDate.getMonth() + 1), pad2(aDate.getDate())].join("-");
			}
		}
		function pad2(a) { return (a < 10)?"0" + a:a; }
		
		return (aFormat || this.mPref_name_format).split("%%").map(function(aPiece) {
			return aPiece.replace(/%(\d*)([tdm])(\"(.*)\")?/g, function($0, $1, $2, $3, $4) {
				$0 = ($2 == "t")?aTitle:($2 == "d")?toISO8601(aDate, $4):pad2(aDate.getHours()) + ":" + pad2(aDate.getMinutes());
				return ($1)?cut($0, Math.max(parseInt($1), 3)):$0;
			});
		}).join("%");
	},

	makeFileName: function(aString)
	{
		return aString.replace(/[^\w ',;!()@&*+=~\x80-\xFE-]/g, "_").substr(0, 64) + this.mSessionExt;
	},
	
	// Look for open window sessions
	getWindowSessions: function()
	{
		return this.mApplication.storage.get(this.mActiveWindowSessions, {});
	},

	getBrowserWindows: function()
	{
		var windowsEnum = this.mWindowMediator.getEnumerator("navigator:browser");
		var windows = [];
		
		while (windowsEnum.hasMoreElements())
		{
			windows.push(windowsEnum.getNext());
		}
		
		return windows;
	},
	
	updateAutoSaveSessions: function(aOldName, aNewName) 
	{
		var updateTitlebar = false;
		
		// auto-save session
		if (this.mPref__autosave_name == aOldName) 
		{
			this.log("updateAutoSaveSessions: autosave change: aOldName = " + aOldName + ", aNewName = " + aNewName, "DATA");
			// rename or delete?
			if (aNewName) {
				this.setPref("_autosave_values", this.mergeAutoSaveValues(aNewName, this.mPref__autosave_group, this.mPref__autosave_time));
			}
			else {
				this.setPref("_autosave_values","");
			}
			updateTitlebar = true;
		}
		
		// window sessions
		this.getBrowserWindows().forEach(function(aWindow) {
			if (aWindow.gSessionManager && aWindow.gSessionManager.__window_session_name && (aWindow.gSessionManager.__window_session_name == aOldName)) { 
				this.log("updateAutoSaveSessions: window change: aOldName = " + aOldName + ", aNewName = " + aNewName, "DATA");
				aWindow.gSessionManager.__window_session_name = aNewName;
				// delete
				if (!aNewName)
				{
					aWindow.gSessionManager.__window_session_group = null;
					aWindow.gSessionManager.__window_session_time = 0;
				}
				updateTitlebar = true;
			}
		}, this);
		
		// Update titlebars
		if (updateTitlebar) this.mObserverService.notifyObservers(null, "sessionmanager:updatetitlebar", null);
	},

	doResumeCurrent: function()
	{
		return (this.getPref("browser.startup.page", 1, true) == 3)?true:false;
	},

	isCleanBrowser: function(aBrowser)
	{
		return aBrowser.sessionHistory.count < 2 && aBrowser.currentURI.spec == "about:blank";
	},

	setDisabled: function(aObj, aValue)
	{
		if (aValue)
		{
			aObj.setAttribute("disabled", "true");
		}
		else
		{
			aObj.removeAttribute("disabled");
		}
	},

	getEOL: function()
	{
		return /win|os[\/_]?2/i.test(navigator.platform)?"\r\n":/mac/i.test(navigator.platform)?"\r":"\n";
	},

	_string: function(aName)
	{
		return this.mBundle.getString(aName);
	},

	// Decode JSON string to javascript object - use JSON if built-in.
	JSON_decode: function(aStr, noError) {
		var jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
		try {
			var hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
		
			// JSON can't parse when string is wrapped in parenthesis
			if (hasParens) {
				aStr = aStr.substring(1, aStr.length - 1);
			}
		
			// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
			try {
				jsObject = this.mNativeJSON.decode(aStr);
			}
			catch (ex) {
				if (/[\u2028\u2029]/.test(aStr)) {
					aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
				}
				jsObject = this.mComponents.utils.evalInSandbox("(" + aStr + ")", new this.mComponents.utils.Sandbox("about:blank"));
			}
		}
		catch(ex) {
			jsObject._JSON_decode_error = ex;
			if (!noError) this.sessionError(ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function(aObj) {
		var jsString = null;
		try {
			jsString = this.mNativeJSON.encode(aObj);
			// Needed until Firefox bug 387859 is fixed or else Firefox won't except JSON strings with \u2028 or \u2029 characters
			if (/[\u2028\u2029]/.test(jsString)) {
				jsString = jsString.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
			}
		}
		catch(ex) {
			this.sessionError(ex);
		}
		return jsString;
	},
	
	// 
	// Logging functions
	// Get logger singleton (this will create it if it does not exist)
	//
	log: function(aMessage, aLevel, aForce) {
		if (this.logger()) this.logger().log(aMessage, aLevel, aForce);
	},

	logError: function(aMessage, aForce) {
		if (this.logger()) this.logger().logError(aMessage, aForce);
	},
	
	deleteLogFile: function(aForce) {
		if (this.logger()) this.logger().deleteLogFile(aForce);
	},

	openLogFile: function() {
		if (this.logger()) this.logger().openLogFile(this._string("file_not_found"));
	}
};

// String.trim is not defined in Firefox 3.0, so define it here if it isn't already defined.
if (typeof(String.trim) != "function") {
	String.prototype.trim = function() {
		return this.replace(/^\s+|\s+$/g, "");
	};
}

// Initialize conditional variables, if no Session Store don't add event listener
if (gSessionManager.initialize()) {
	window.addEventListener("load", gSessionManager.onLoad_proxy, false);
}