const SM_VERSION = "0.6.3";

/*const*/ var gSessionManager = {
	_timer : null,
	
	mSessionStoreValue : null,
	mSessionStartupValue : null,
	mObserverService: Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService),
	mPrefRoot: Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefBranch2),
	mWindowMediator: Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator),
	mPromptService: Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService),
	mProfileDirectory: Components.classes["@mozilla.org/file/directory_service;1"].getService(Components.interfaces.nsIProperties).get("ProfD", Components.interfaces.nsILocalFile),
	mIOService: Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService),
	mSecretDecoderRing: Components.classes["@mozilla.org/security/sdr;1"].getService(Components.interfaces.nsISecretDecoderRing),
	mComponents: Components,

	mObserving: ["sessionmanager:windowtabopenclose", "sessionmanager-list-update", "sessionmanager:updatetitlebar", "browser:purge-session-history", "quit-application-granted", "private-browsing"],
	mClosedWindowFile: "sessionmanager.dat",
	mBackupSessionName: "backup.session",
	mBackupSessionRegEx: /^backup(-[1-9](\d)*)?\.session$/,
	mAutoSaveSessionName: "autosave.session",
	mSessionExt: ".session",
	mFirstUrl: "http://sessionmanager.mozdev.org/documentation.html",
	mSessionRegExp: /^\[SessionManager\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session\/?\d*|window)\tcount=([1-9][0-9]*)\/([1-9][0-9]*)(\tgroup=(.+))?/m,

	mLastState: null,
	mCleanBrowser: null,
	mClosedWindowName: null,
	
	// Used to store original closeWindow function
	mOrigCloseWindow: null,
	
	mSessionCache: { timestamp: 0 },
	mClosedWindowsCache: { timestamp: 0, data: null },
	
	mSanitizePreference: "privacy.item.extensions-sessionmanager",
	
	mSessionStore : function() {
		// Get SessionStore component if not already retrieved
		if (!this.mSessionStoreValue) {
		
			// Firefox
			if (this.mComponents.classes["@mozilla.org/browser/sessionstore;1"]) {
				this.mSessionStoreValue = this.mComponents.classes["@mozilla.org/browser/sessionstore;1"].
					getService(this.mComponents.interfaces.nsISessionStore);
				this.mSessionStartupValue = this.mComponents.classes["@mozilla.org/browser/sessionstartup;1"].
					getService(this.mComponents.interfaces.nsISessionStartup);
			}
			// SeaMonkey
			else if (this.mComponents.classes["@mozilla.org/suite/sessionstore;1"]) {
				this.mSessionStoreValue = this.mComponents.classes["@mozilla.org/suite/sessionstore;1"].
					getService(this.mComponents.interfaces.nsISessionStore);
				this.mSessionStartupValue = this.mComponents.classes["@mozilla.org/suite/sessionstartup;1"].
					getService(this.mComponents.interfaces.nsISessionStartup);
			}
			// Not supported
			else {
				var sessionButton = document.getElementById("sessionmanager-toolbar");
				var undoButton = document.getElementById("sessionmanager-undo");
				var sessionMenu = document.getElementById("sessionmanager-menu");
				if (sessionButton) sessionButton.hidden = true;
				if (undoButton) undoButton.hidden = true;
				if (sessionMenu) sessionMenu.hidden = true;
				if (!this.getPref("browser.sessionmanager.uninstalled", false, true)) {
					this.mBundle = document.getElementById("bundle_sessionmanager");
					this.mTitle = this._string("sessionManager");
					this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, this._string("not_supported"));
		    		var liExtensionManager = this.mComponents.classes["@mozilla.org/extensions/manager;1"].getService(this.mComponents.interfaces.nsIExtensionManager);
					liExtensionManager.uninstallItem("{1280606b-2510-4fe0-97ef-9b5a22eafe30}");
					this.setPref("browser.sessionmanager.uninstalled", true, true);
				}
				window.addEventListener("unload", gSessionManager.onUnload_Uninstall, false);
			}
		}
		return this.mSessionStoreValue;
	},

/* ........ Listeners / Observers.............. */

	onLoad_proxy: function()
	{
		this.removeEventListener("load", gSessionManager.onLoad_proxy, false);
		
		if (gSessionManager.mSessionStore()) {
			window.addEventListener("unload", gSessionManager.onUnload_proxy, false);			
			gSessionManager.onLoad();
		}
	},

	onLoad: function(aDialog)
	{
		this.mBundle = document.getElementById("bundle_sessionmanager");
		this.mTitle = this._string("sessionManager");
		this.mEOL = this.getEOL();
		
		// Fix tooltips for toolbar buttons
		var buttons = [document.getElementById("sessionmanager-toolbar"), document.getElementById("sessionmanager-undo")];
		for (var i=0; i < buttons.length; i++) {
			if (buttons[i] && buttons[i].boxObject && buttons[i].boxObject.firstChild)
				buttons[i].boxObject.firstChild.tooltipText = buttons[i].getAttribute("buttontooltiptext");
		}
		
		// Determine Mozilla version to see what is supported
		this.mAppVersion = "0";
		this.mAppID = "UNKNOWN";
		try {
			var appInfo = Components.classes["@mozilla.org/xre/app-info;1"].getService(Components.interfaces.nsIXULAppInfo);
			this.mAppVersion = appInfo.platformVersion;
			switch (appInfo.ID) {
				case "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}":
					this.mAppID = "FIREFOX";
					break;
				case "{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}":
					this.mAppID = "SEAMONKEY";
					break;
			}
		} catch (e) { dump(e + "\n"); }

		// This will force SessionStore to be enabled since Session Manager cannot work without SessionStore being 
		// enabled and presumably anyone installing Session Manager actually wants to use it. 
		// This preference no longer exists as of Firefox 3.1 so don't set it, if there is no default value
		if (this.mAppVersion < "1.9.1") {
			if (!this.getPref("browser.sessionstore.enabled", true, true)) {
				this.setPref("browser.sessionstore.enabled", true, true);
			}
		}
		
		this.mPrefBranch = this.mPrefRoot.QueryInterface(Components.interfaces.nsIPrefService).getBranch("extensions.sessionmanager.").QueryInterface(Components.interfaces.nsIPrefBranch2);
		this.mPrefBranch2 = this.mPrefRoot.QueryInterface(Components.interfaces.nsIPrefService).getBranch("browser.startup.").QueryInterface(Components.interfaces.nsIPrefBranch2);
		
		if (!window.SessionManager) // if Tab Mix Plus isn't installed
		{
			window.SessionManager = gSessionManager;
		}
				
		if (aDialog || this.mFullyLoaded)
		{
			return;
		}
		
		// This will handle any left over processing that results from closing the last browser window, but
		// not actually exiting the browser and then opening a new browser window.
		if (this.getBrowserWindows().length == 1) this.mObserverService.notifyObservers(window, "sessionmanager:process-closed-window", null);
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.addObserver(this, aTopic, false);
		}, this);
		this.mObserverService.addObserver(this, "quit-application", false);
		this.mObserverService.addObserver(this, "sessionmanager:process-closed-window", false);
		// The following is needed to handle extensions who issue bad restarts in Firefox 2.0
		if (this.mAppVersion < "1.9") this.mObserverService.addObserver(this, "quit-application-requested", false);
		
		this.mPref_autosave_session = this.getPref("autosave_session", true);
		this.mPref_backup_session = this.getPref("backup_session", 1);
		this.mPref_click_restore_tab = this.getPref("click_restore_tab", true);
		this.mPref_encrypt_sessions = this.getPref("encrypt_sessions", false);
		this.mPref_encrypted_only = this.getPref("encrypted_only", false);
		this.mPref_max_backup_keep = this.getPref("max_backup_keep", 0);
		this.mPref_max_closed_undo = this.getPref("max_closed_undo", 10);
		this.mPref_max_display = this.getPref("max_display", 20);
		this.mPref_name_format = this.getPref("name_format", "%40t-%d");
		this.mPref_overwrite = this.getPref("overwrite", false);
		this.mPref_reload = this.getPref("reload", false);
		this.mPref_restore_temporary = this.getPref("restore_temporary", false);
		this.mPref_resume_session = this.getPref("resume_session", this.mBackupSessionName);
		this.mPref_save_closed_tabs = this.getPref("save_closed_tabs", 0);
		this.mPref_save_cookies = this.getPref("save_cookies", false);
		this.mPref_save_window_list = this.getPref("save_window_list", false);
		this.mPref_session_list_order = this.getPref("session_list_order", 1);
		this.mPref_shutdown_on_last_window_close = this.getPref("shutdown_on_last_window_close", false);
		this.mPref_hide_tools_menu = this.getPref("hide_tools_menu", false);
		this.mPref_startup = this.getPref("startup",0);
		this.mPref_submenus = this.getPref("submenus", false);
		this.mPref__running = this.getPref("_running", false);
		// split out name and group
		this.getAutoSaveValues(this.getPref("_autosave_values", ""));
		this.mPrefBranch.addObserver("", this, false);
		this.mPrefBranch2.addObserver("page", this, false);
		
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
		
		// Make sure Session Store is initialzed - It doesn't seem to initialize in all O/S builds of Firefox.
		this.mSessionStore().init(window);
		
		this.synchStartup("page");   // Let Firefox's preference override ours if it changed when browser not running
		this.recoverSession();
		this.updateToolbarButton();
		
		if (!this.mPref__running)
		{
			// If backup file is temporary, then delete it
			try {
				if (this.getPref("backup_temporary", true)) {
					this.setPref("backup_temporary", false)
					this.delFile(this.getSessionDir(this.mBackupSessionName));
				}
			} catch (ex) { dump(ex + "\n"); }

			// If we did a temporary restore, set it to false			
			if (this.mPref_restore_temporary) this.setPref("restore_temporary", false)
			
			// make sure that the _running preference is saved in case we crash
			this.setPref("_running", true);
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
		this.mSessionStore().persistTabAttribute("image");
		
		// Workaround for bug 360408 in Firefox 2.0.  Wrap closeWindow function so our function gets called when window closes.
		if (this.mAppVersion < "1.9") {
			this.mOrigCloseWindow = closeWindow;
			closeWindow = function() { 
				var result = gSessionManager.mOrigCloseWindow.apply(this, arguments);
				if (result) {
					try {
						gSessionManager.onWindowClose();
					}
					catch (ex) {
						dump(ex + "\n");
					}
				}
				return result;
			}
		}
		
		// SeaMonkey doesn't have an undoCloseTab function so create one
		if (typeof(undoCloseTab) == "undefined") {
			undoCloseTab = function (aIndex) { gSessionManager.undoCloseTabSM(aIndex); }
		}
		
		// add call to gSessionManager_Sanitizer (code take from Tab Mix Plus)
		// nsBrowserGlue.js use loadSubScript to load Sanitizer so we need to add this here for the case
		// where the user disabled option to prompt before clearing data 
		var cmd = document.getElementById("Tools:Sanitize");
		if (cmd) cmd.setAttribute("oncommand", "gSessionManager.tryToSanitize();" + cmd.getAttribute("oncommand"));
		
		// read current window session		
		//this.__window_session_name = this.mSessionStore().getWindowValue(window,"_sm_window_session_name");
		//if (this.__window_session_name) escape(this.__window_session_name);
		//dump("restore done " + this.__window_session_name + "\n");

		// Remove change made in 0.6 (only do this once)
		if (this.getPref("version", "") == "0.6")
		{
			this.delPref("browser.warnOnQuit", true);
		}
		
		// Perform any needed update processing
		var oldVersion = this.getPref("version", "")
		if (oldVersion != SM_VERSION)
		{
			// this isn't used anymore
			if (oldVersion < "0.6.2.5") this.delPref("_no_reload");

			// Clean out screenX and screenY persist values from localstore.rdf since we don't persist anymore.
			if (oldVersion < "0.6.2.1") {
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
			if (oldVersion < "0.6.2.8") {
				var sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (aSession.backup) {
						this.group(aSession.fileName, this._string("backup_sessions"));
					}
				}, this);
			}
			
			this.setPref("version", SM_VERSION);
			
			// One time message on update
			setTimeout(function() {
				var tBrowser = getBrowser();
				tBrowser.selectedTab = tBrowser.addTab(gSessionManager.mFirstUrl);
			},100);
			
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
	
	onUnload_proxy: function()
	{
		this.removeEventListener("unload", gSessionManager.onUnload_proxy, false);
		gSessionManager.onUnload();
	},

	onUnload: function()
	{
		var allWindows = this.getBrowserWindows();
		var numWindows = allWindows.length;
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.removeObserver(this, aTopic);
		}, this);
		this.mPrefBranch.removeObserver("", this);
		this.mPrefBranch2.removeObserver("page", this);
		
		gBrowser.removeEventListener("TabClose", this.onTabOpenClose, false);
		gBrowser.removeEventListener("TabOpen", this.onTabOpenClose, false);
		if (this.mPref_reload) {
			gBrowser.removeEventListener("SSTabRestored", this.onTabRestored_proxy, false);
			gBrowser.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
		}
		gBrowser.mStrip.removeEventListener("click", this.onTabBarClick, false);
		
		// restore original close window functionality
		if (this.mOrigCloseWindow) {
			closeWindow = this.mOrigCloseWindow;
			this.mOrigCloseWindow = null;
		}
		
		// stop watching for titlebar changes
		gBrowser.ownerDocument.unwatch("title");
		
		// Last window closing will leaks briefly since "quit-application" observer is not removed from it 
		// until after shutdown is run, but since browser is closing anyway, who cares?
		if (numWindows != 0) {
			this.mObserverService.removeObserver(this, "sessionmanager:process-closed-window");
			this.mObserverService.removeObserver(this, "quit-application");
		}
		
		// Stop timer and start another if needed
		if (this._timer) { 
			//dump("Timer stopped because window closed\n");
			this._timer.cancel();
			this._timer = null;
			if (numWindows != 0) allWindows[0].gSessionManager.checkTimer();
		}

		// Only do the following in Firefox 3.0 and above where bug 360408 is fixed.
		if (this.mAppVersion >= "1.9") this.onWindowClose();
				
		if (this.mPref__running && numWindows == 0)
		{
			this._string_preserve_session = this._string("preserve_session");
			this._string_backup_session = this._string("backup_session");
			this._string_backup_sessions = this._string("backup_sessions");
			this._string_old_backup_session = this._string("old_backup_session");
			this._string_prompt_not_again = this._string("prompt_not_again");
			this._string_encrypt_fail = this._string("encrypt_fail");
			this._string_encrypt_fail2 = this._string("encrypt_fail2");
			this._string_save_and_restore = this._string("save_and_restore");
			
			this.mTitle += " - " + document.getElementById("bundle_brand").getString("brandFullName");
			this.mBundle = null;
			
			// This executes in Firefox 2.x if last browser window closes and non-browser windows are still open
			// or if Firefox is restarted. In Firefox 3.0, it executes whenever the last browser window is closed.
			if (this.mPref_shutdown_on_last_window_close && !this.mPref__stopping) {
				this.mObserverService.removeObserver(this, "sessionmanager:process-closed-window");
				this.mObserverService.removeObserver(this, "quit-application");
				// Don't do shutdown processing when entering private browsing mode
				if (!this.doNotShutdown) this.shutDown();
			}
		}
		this.mBundle = null;
		this.mFullyLoaded = false;
	},

	observe: function(aSubject, aTopic, aData)
	{
		switch (aTopic)
		{
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
				catch(ex) { dump(ex + "\n"); }
				this.mLastState = null;
				this.mCleanBrowser = null;
				this.mClosedWindowName = null;
				this.mObserverService.removeObserver(this, "sessionmanager:process-closed-window");
				this.mObserverService.removeObserver(this, "quit-application");
				//dump("done processing closed window\n");
			}
			break;
		case "sessionmanager:updatetitlebar":
			gBrowser.updateTitlebar();
			break;
		case "browser:purge-session-history":
			this.clearUndoData("all");
			break;
		case "private-browsing":
			if (aData == "enter") {
				// Prevent this window from triggering shutdown processing when it is closed on entering private browsing mode
				this.doNotShutdown = true;
				// Only do the following once
				if (!this.doNotDoPrivateProcessing) {
					// Close current autosave session or make an autosave backup.
					if (!this.closeSession(false,true) && (this.mPref_autosave_session)) {
						this.autoSaveCurrentSession(true); 
					}
					
					// Prevent other windows from doing the saving processing
					this.getBrowserWindows().forEach(function(aWindow) {
						if (aWindow != window) { 
							aWindow.gSessionManager.doNotDoPrivateProcessing = true; 
						}
					});
				}
			}
			break;
		case "sessionmanager-list-update":
			// this session cache from updated window so this window doesn't need to read from disk
			if (window != aSubject) {
				if (this.mSessionCache.timestamp < aSubject.gSessionManager.mSessionCache.timestamp) {
					//dump("Updating window " + window.window.document.title + "\n");
					this.mSessionCache = aSubject.gSessionManager.mSessionCache;
				}
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
				if (this.mPref_max_closed_undo == 0)
				{
					this.clearUndoData("window", true);
				}
				else
				{
					var closedWindows = this.getClosedWindows();
					if (closedWindows.length > this.mPref_max_closed_undo)
					{
						this.storeClosedWindows(closedWindows.slice(0, this.mPref_max_closed_undo));
					}
				}
				break;
			case "page":
			case "startup":
			case "resume_session":
				this.synchStartup(aData);
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
			}
			break;
		case "quit-application-requested":
			// this is only registered for Firefox 2.0 to handle when extension issue a restart since most do not send a 
			// quit-application-granted notification causing SessionStore to drop all but one window
			this.mObserverService.removeObserver(this, "quit-application-requested");
			if (aData == "restart") {
				var os = Components.classes["@mozilla.org/observer-service;1"]
   		                  .getService(Components.interfaces.nsIObserverService);
   		        os.notifyObservers(null, "quit-application-granted", null);
			}
			break;
		case "quit-application":
			this.mObserverService.removeObserver(this, "sessionmanager:process-closed-window");
			this.mObserverService.removeObserver(this, "quit-application");
			// only run shutdown for one window and if not restarting browser
			if (aData != "restart")
			{
				this.shutDown();
			}
			break;
		case "quit-application-granted":
			// quit granted so stop listening for closed windows
			this.mPref__stopping = true;
			this._mUserDirectory = this.getUserDir("sessions");
			break;
		// timer periodic call
		case "timer-callback":
			// save auto-save session if open, but don't close it
			//dump("Timer callback\n");
			this.closeSession(false, false, true);
			break;
		}
	},

	onTabOpenClose: function(aEvent)
	{
		// Give browser a chance to update count closed tab count.  Only SeaMonkey currently needs this, but it doesn't hurt Firefox.
		setTimeout(function () { gSessionManager.updateToolbarButton(); }, 0);
	},
	
	// This is to try and prevent tabs that are closed during the restore preocess from actually reloading.  
	// It doesn't work all the time, but it's better than nothing.
	onTabRestoring_proxy: function(aEvent) {
		// If tab reloading enabled and not offline
		if (gSessionManager.mPref_reload && !gSessionManager.mIOService.offline) {

			var sessionStore = gSessionManager.mSessionStore();
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
			var sessionStore = gSessionManager.mSessionStore();
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
			if (this.mAppVersion < "1.9") {
				// The dispatch event method won't work for "command" in Firefox 2.0, so we need to use eval()
				eval("var event = { shiftKey: true }; " + aButton.getAttribute("oncommand"));
			}
			else {
				var event = document.createEvent("XULCommandEvents");
				event.initCommandEvent("command", false, true, window, 0, false, false, true, false, null);
				aButton.dispatchEvent(event);
			}
		}
		else if (aEvent.button == 2 && aButton.getAttribute("disabled") != "true")
		{
			aButton.open = true;
		}
	},

	onWindowClose: function()
	{
		// if there is a window session save it
		if (this.__window_session_name) 
		{
			this.closeSession(true);
		}
			
		// only save closed window if running and not shutting down 
		if (this.mPref__running && !this.mPref__stopping)
		{
			// Get number of windows open after closing this one.  Firefox 2.0 counts the closing window as open so decrement by one.
			var numWindows = this.getBrowserWindows().length;
			if (!this.mLastState && (this.mAppVersion < "1.9")) numWindows--;
			
			// save window in closed window list if not last window, otherwise store the last window state for use later
			if (numWindows > 0)
			{
				var state = this.getSessionState(null, true, null, null, null, true);
				this.appendClosedWindow(state);
				this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
			}
			else
			{
				// store current window or session data in case it's needed later
				// Don't do this if preference to shutdown on last window closed is set.
				if (!this.mPref_shutdown_on_last_window_close) {
					var name = (this.mPref__autosave_name) ? this.mPref__autosave_name : this.__window_session_name;
					this.mLastState = (name) ? 
		    	               this.getSessionState(name, null, this.mPref_save_closed_tabs < 2, true, this.mPref__autosave_group, true, this.mPref__autosave_time) :
		        	           this.getSessionState(null, true, null, null, null, true); 
					this.mCleanBrowser = Array.every(gBrowser.browsers, this.isCleanBrowser);
					this.mClosedWindowName = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:this._string("untitled_window"));
				}
			}
		}
	},
	
	// Put current session name in browser titlebar
	// This is a watch function which is called any time the titlebar text changes
	// See https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Global_Objects/Object/watch
	updateTitlebar: function(id, oldVal, newVal)
	{
		if (id == "title") {
			// Don't kill browser if something goes wrong
			try {
				var sessionTitleName = (gSessionManager.mPref__autosave_name) ? (" - (" + gSessionManager._string("current_session2") + " " + gSessionManager.mPref__autosave_name + ")") : "";
				var windowTitleName = (gSessionManager.__window_session_name) ? (" - (" + gSessionManager._string("current_session2") + " " + gSessionManager.__window_session_name + ")") : "";
		
				// Add window and browser session titles
				newVal = newVal + windowTitleName + sessionTitleName;
			} 
			catch (ex) { 
				dump(ex + "\n"); 
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
		var abandon = get_("abandon");
		var save = get_("save");
		var backupMenu = get_("backup-menu");
				
		for (var item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		// Firefox 2.0 does not have a menupopup element
		var backupPopup = backupMenu.menupopup || backupMenu.lastChild; 
		while (backupPopup.childNodes.length) backupPopup.removeChild(backupPopup.childNodes[0]);
		
		closer.hidden = abandon.hidden = (this.mPref__autosave_name=="");
		save.hidden = (this.getBrowserWindows().length == 1);
		
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
		var user_latest = backup_latest = false;
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
		
		var undoDisabled = (this.mPref_max_closed_undo == 0 && this.getPref("browser.sessionstore.max_tabs_undo", 10, true) == 0);
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
				if (item.getAttribute("statustext") != "") {
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
		aOneWindow = aOneWindow && (this.getBrowserWindows().length > 1);
		
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
//			if (aOneWindow) this.mSessionStore().setWindowValue(window,"_sm_window_session_name",(values.autoSave)?escape(aName):"");
			
			var file = this.getSessionDir(aFileName || this.makeFileName(aName), !aFileName);
			try
			{
				this.writeFile(file, this.getSessionState(aName, aOneWindow, this.mPref_save_closed_tabs < 2, values.autoSave, aGroup, null, values.autoSaveTime));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
//		if (!aOneWindow)
//		{
			if (values.autoSave)
			{
				this.setPref("_autosave_values", this.mergeAutoSaveValues(aName, aGroup, values.autoSaveTime));
			}
			else if (this.mPref__autosave_name == aName)
			{
				// If in auto-save session and user saves on top of it as manual turn off autosave
				this.setPref("_autosave_values","");
			}
//		}
//		else 
//		{
//			this.__window_session_name = (values.autoSave) ? aName : null;
//			gBrowser.updateTitlebar();
//		}
	},

	saveWindow: function(aName, aFileName, aGroup)
	{
		this.save(aName, aFileName, aGroup, true);
	},
	
	// if aOneWindow is true, then close the window session otherwise close the browser session
	closeSession: function(aOneWindow, aForceSave, keepOpen)
	{
		var name = (aOneWindow) ? this.__window_session_name : this.mPref__autosave_name;
		var group = (aOneWindow) ? null : this.mPref__autosave_group;
		var time = (aOneWindow) ? 0 : this.mPref__autosave_time;
		if (name != "")
		{
			var file = this.getSessionDir(this.makeFileName(name));
			try
			{
				if (aForceSave || !this.isPrivateBrowserMode()) this.writeFile(file, this.getSessionState(name, aOneWindow, this.mPref_save_closed_tabs < 2, true, group, null, time));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		
			if (!keepOpen) {
				if (!aOneWindow) this.setPref("_autosave_values","");
				else this.__window_session_name = null;
			}
			return true;
		}
		return false;
	},
	
	abandonSession: function()
	{
		var dontPrompt = { value: false };
		if (this.getPref("no_abandon_prompt") || this.mPromptService.confirmEx(null, this.mTitle, this._string("abandom_prompt"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			this.setPref("_autosave_values","");
			if (dontPrompt.value)
			{
				this.setPref("no_abandon_prompt", true);
			}
		}
	},

	load: function(aFileName, aMode, aChoseTabs)
	{
		var state, chosenState;
		if (!aFileName) {
			var values = { append_replace: true };
			aFileName = this.selectSession(this._string("load_session"), this._string("load_session_ok"), values);
			if (!aFileName || !this.getSessionDir(aFileName).exists()) return;
			aChoseTabs = values.choseTabs;
			aMode = values.append ? "newwindow" : "overwrite";
		}
		if (aChoseTabs) {
			// Get windows and tabs chosen by user
			var smHelper = Components.classes["@morac/sessionmanager-helper;1"].getService(Components.interfaces.nsISessionManangerHelperComponent);
			chosenState = smHelper.mSessionData;
			smHelper.setSessionData("");
			
			// Get session header data from disk
			state = this.readSessionFile(this.getSessionDir(aFileName), true);
		}
		else state = this.readSessionFile(this.getSessionDir(aFileName));
		if (!state)
		{
			this.ioError();
			return;
		}

		if (this.mSessionRegExp.test(state))
		{
			var name = RegExp.$1;
			var autosave = RegExp.$3;
			var group = RegExp.$7;
			state = (aChoseTabs && chosenState) ? chosenState : state.split("\n")[4];
			
			// Don't save current session on startup since there isn't any.  Don't save if opening
			// new window or appending to current session since nothing is lost in that case.
			if (aMode != "startup" && aMode != "newwindow" && aMode != "append")
			{
				// close current autosave session if open
				if (this.mPref__autosave_name != "" && aMode != "newwindow" && aMode != "append") 
				{
					this.closeSession(false);
				}
				else 
				{
					if (this.mPref_autosave_session) this.autoSaveCurrentSession();
				}
			}
			
			// If this is an autosave session, keep track of it if there is not already an active session and not in private
			// browsing mode and did not chose tabs
			if (!aChoseTabs && this.mPref__autosave_name=="" && /^session\/?(\d*)$/.test(autosave) && !this.isPrivateBrowserMode()) 
			{
				var time = parseInt(RegExp.$1);
				this.setPref("_autosave_values", this.mergeAutoSaveValues(name, group, time));
			}
		}
		else {
			this.ioError();
			return;
		}
		
		var newWindow = false;
		var overwriteTabs = true;
		var tabsToMove = null;
		var stripClosedTabs = !this.mPref_save_closed_tabs || (this.mPref_save_closed_tabs == 1 && (aMode != "startup"));

		// gSingleWindowMode is set if Tab Mix Plus's single window mode is enabled
		var TMP_SingleWindowMode = false;
	
		try
		{
			TMP_SingleWindowMode = gSingleWindowMode;
			if (TMP_SingleWindowMode && (aMode != "startup") && (aMode != "overwrite") && !this.mPref_overwrite)
				aMode = "append";
		}
		catch (ex) {}
		
		aMode = aMode || "default";
		if (aMode == "startup")
		{
			overwriteTabs = this.isCmdLineEmpty();
			tabsToMove = (!overwriteTabs)?Array.slice(gBrowser.mTabs):null;
		}
		else if (aMode == "append")
		{
			overwriteTabs = false;
		}
		else if (!TMP_SingleWindowMode && (aMode == "newwindow" || (aMode != "overwrite" && !this.mPref_overwrite)))
		{
			// if there is only a blank window with no closed tabs, just use that instead of opening a new window
			var tabs = window.getBrowser();
			if (this.getBrowserWindows().length != 1 || !tabs || tabs.mTabs.length > 1 || 
				tabs.mTabs[0].linkedBrowser.currentURI.spec != "about:blank" || 
				this.mSessionStore().getClosedTabCount(window) > 0) {
				newWindow = true;
			}
		}
		else
		{
			// Don't save closed windows when loading session
			this.getBrowserWindows().forEach(function(aWindow) {
				if (aWindow != window) { 
					aWindow.gSessionManager.mPref__stopping = true; 
					// If not Firefox 3 call onWindowClose to save current window session since it isn't done in FF2
					if (this.mAppVersion < "1.9") aWindow.gSessionManager.onWindowClose();
				}
			});
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
			catch (ex) { dump(ex + "\n"); };
		}
		
		setTimeout(function() {
			var tabcount = gBrowser.mTabs.length;
			var okay = gSessionManager.restoreSession((!newWindow)?window:null, state, overwriteTabs, stripClosedTabs, (overwriteTabs && !newWindow && !TMP_SingleWindowMode), TMP_SingleWindowMode);
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
		if (aSession) values = { name: aSession, text: this.mSessionCache[aSession].name };
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
			var state = this.readSessionFile(file);
			var oldname = null;
			// Get original name
			if (/^(\[SessionManager\])(?:\nname=(.*))?/m.test(state)) oldname = RegExp.$2;
			// if window session file update _sm_window_session_name data
			if (/\nautosave=window\t/m.test(state)) {
				state = state.split("\n")
				state[4] = this.decrypt(state[4]);
				if (!state[4]) return;
				state[4] = this.JSON_decode(state[4]);
				if (state[4] && state[4].windows) {
					// replace window session name in window session window
					for (var i=0; i<state[4].windows.length; i++) {
						if (state[4].windows[i].extData && (state[4].windows[i].extData._sm_window_session_name == escape(oldname))) {
							state[4].windows[i].extData._sm_window_session_name = escape(values.text);
						}
					}
				}
				state[4] = this.JSON_encode(state[4]);
				state[4] = this.decryptEncryptByPreference(state[4]); 
				if (!state[4]) return;
				state = state.join("\n");
			}
			// remove group name if it was a backup session
			if (this.mSessionCache[values.name].backup) state = state.replace(/\tgroup=.+$/m, "");
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

			// Renamed active session
			if (this.mPref__autosave_name == oldname)
			{
				this.setPref("_autosave_values", this.mergeAutoSaveValues(values.text, this.mPref__autosave_group, this.mPref__autosave_time));
			}
			// Renamed window session
			this.getBrowserWindows().forEach(function(aWindow) {
				if (aWindow.gSessionManager && (aWindow.gSessionManager.__window_session_name == oldname)) { 
					aWindow.gSessionManager.__window_session_name = values.text;
					this.mSessionStore().setWindowValue(aWindow,"_sm_window_session_name",escape(values.text));
					this.mObserverService.notifyObservers(null, "sessionmanager:updatetitlebar", null);
				}
			}, this);
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
					var state = this.readSessionFile(file);
					state = state.replace(/(\tcount=\d+\/\d+)(\tgroup=.+)?$/m, function($0, $1) { return $1 + (values.group ? ("\tgroup=" + values.group) : ""); });
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
		
		var closedWindows = this.getClosedWindows();
		closedWindows.forEach(function(aWindow, aIx) {
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", aWindow.name);
			menuitem.setAttribute("index", "window" + aIx);
			menuitem.setAttribute("oncommand", 'gSessionManager.undoCloseWindow(' + aIx + ', (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.ctrlKey || event.metaKey)?"append":"");');
			menuitem.setAttribute("onclick", 'gSessionManager.clickClosedUndoMenuItem(event);');
			menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
			aPopup.insertBefore(menuitem, separator);
		});
		label.hidden = (closedWindows.length == 0);
		
		var listEnd = get_("end-separator");
		for (item = separator.nextSibling.nextSibling; item != listEnd; item = separator.nextSibling.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		var closedTabs = this.mSessionStore().getClosedTabData(window);
		var mClosedTabs = [];
		closedTabs = this.JSON_decode(closedTabs);
		if (this.mAppVersion < "1.9") this.fixBug350558(closedTabs);
		closedTabs.forEach(function(aValue, aIndex) {
			mClosedTabs[aIndex] = { title:aValue.title, image:null, 
								url:aValue.state.entries[aValue.state.entries.length - 1].url }
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
			// Firefox 3.1 uses attributes instead of xultab
			if (aValue.state.attributes && aValue.state.attributes.image)
			{
				mClosedTabs[aIndex].image = aValue.state.attributes.image;
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
			// Removing closed tabs does not work in SeaMonkey so don't give option to do so.
			if (this.mAppID != "SEAMONKEY") {
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
			try
			{
				if (gSingleWindowMode) aMode = "append";
			}
			catch (ex) {}

			if (aMode == "overwrite")
			{
				this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
			}
			
			var okay = this.restoreSession((aMode == "overwrite" || aMode == "append")?window:null, state, aMode != "append");
			if (okay) {
				this.storeClosedWindows(closedWindows);
				this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
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
			closedWindows.splice(aIx, 1)[0].state;
			this.storeClosedWindows(closedWindows);
			this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, closedWindows.length, "window");
		}
		// removing tab item
		else if (indexAttribute.indexOf("tab") != -1) {
			// get index
			aIx = indexAttribute.substring(3);
			
			// This code is based off of code in Tab Mix Plus
			var state = { windows: [], _firstTabs: true };
			state.windows[0] = { _closedTabs: [] };

			if (aIx >= 0) {
				// get closed-tabs from nsSessionStore
				var closedTabs = this.JSON_decode(this.mSessionStore().getClosedTabData(window));
				// Work around for bug 350558 which sometimes mangles the _closedTabs.state.entries array data
				if (this.mAppVersion < "1.9") this.fixBug350558(closedTabs);
				// purge closed tab at aIndex
				closedTabs.splice(aIx, 1);
				state.windows[0]._closedTabs = closedTabs;
			}

			// replace existing _closedTabs
			this.mSessionStore().setWindowState(window, this.JSON_encode(state), false);
			
			// update the remaining entries
			this.updateClosedList(aTarget, aIx, state.windows[0]._closedTabs.length, "tab");
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

		this.clearUndoData("window");

		gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
	},
	
/* ........ Right click menu handlers .............. */
// Firefox 2.0 does not close parent menu when context menu closes so force it closed

	group_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var childMenu = document.popupNode.menupopup || document.popupNode.lastChild;
		childMenu.hidePopup();
	},
	
	group_rename: function() {
		if (this.mAppVersion < "1.9") this.hidePopup();
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
			if (this.mAppVersion < "1.9") this.hidePopup();
			
			var sessions = this.getSessions();
			sessions.forEach(function(aSession) {
				if (aSession.group == group) {
					this.delFile(this.getSessionDir(aSession.fileName));
					// if loaded autosave session in deleted group, clear preference
					if (aSession.name == this.mPref__autosave_name) this.setPref("_autosave_values","");
				}
			}, this);
		}
	},

	session_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var current = (document.popupNode.getAttribute("disabled") == "true");
		var replace = get_("replace");
		
		replace.hidden = (this.getBrowserWindows().length == 1);
		
		// Disable saving in privacy mode or loaded auto-save session
		var inPrivateBrowsing = this.isPrivateBrowserMode();
		this.setDisabled(replace, (inPrivateBrowsing | current));
		this.setDisabled(get_("replacew"), (inPrivateBrowsing | current));
		
		// Disable almost everything for currently loaded auto-save session
		this.setDisabled(get_("loada"), current);
		this.setDisabled(get_("loadr"), current);

		// Hide change group choice for backup items		
		get_("changegroup").hidden = (document.popupNode.getAttribute("backup-item") == "true")
		
		// Disable setting startup if already startup
		this.setDisabled(get_("startup"), ((this.mPref_startup == 2) && (document.popupNode.getAttribute("filename") == this.mPref_resume_session)));
	},

	session_load: function(aReplace) {
		if (this.mAppVersion < "1.9") this.hidePopup();
		var session = document.popupNode.getAttribute("filename");
		var oldOverwrite = this.mPref_overwrite;
		if (aReplace) {
			this.mPref_overwrite = true;
			this.load(session);
		}
		else {
			var state = this.readSessionFile(this.getSessionDir(session),true);
			var newWindow = (((this.mSessionRegExp.test(state))?RegExp.$4:0) > 1) || this.getBrowserWindows().length > 1;
			this.mPref_overwrite = false;
			this.load(session, (newWindow)?"newwindow":"append");
		}
		this.mPref_overwrite = oldOverwrite;
	},
	
	session_replace: function(aWindow) {
		if (this.mAppVersion < "1.9") this.hidePopup();
		var session = document.popupNode.getAttribute("filename");
		var parent = document.popupNode.parentNode.parentNode;
		var group = null;
		if (parent.id.indexOf("sessionmanager-") == -1) {
			group = parent.label;
		}
		if (aWindow) {
			this.saveWindow(this.mSessionCache[session].name, session, group);
		}
		else {
			this.save(this.mSessionCache[session].name, session, group);
		}
	},
	
	session_rename: function() {
		if (this.mAppVersion < "1.9") this.hidePopup();
		var session = document.popupNode.getAttribute("filename");
		this.rename(session);
	},

	session_remove: function() {
		var dontPrompt = { value: false };
		var session = document.popupNode.getAttribute("filename");
		if (this.getPref("no_delete_prompt") || this.mPromptService.confirmEx(window, this.mTitle, this._string("delete_confirm"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0) {
			if (this.mAppVersion < "1.9") this.hidePopup();
			// if currently loaded autosave session clear autosave name
			if (document.popupNode.getAttribute("disabled") == "true") {
				this.setPref("_autosave_values","");
			}
			this.remove(session);
			if (dontPrompt.value) {
				this.setPref("no_delete_prompt", true);
			}
		}
	},
	
	session_setStartup: function() {
		if (this.mAppVersion < "1.9") this.hidePopup();
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
			"chrome://sessionmanager/content/sessionexplorer.xul",
			"chrome,titlebar,centerscreen,modal,resizable,dialog=yes",
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
						  ((aValues.append_replace)?64:0) | ((aValues.allowNamedReplace)?256:0));
		
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,modal,resizable,dialog=yes", params, (this.mFullyLoaded)?window:null);
		
		aValues.name = params.GetString(3);
		aValues.text = params.GetString(6);
		aValues.group = params.GetString(7);
		aValues.ignore = (params.GetInt(1) & 4)?1:0;
		aValues.autoSave = (params.GetInt(1) & 8)?1:0;
		aValues.choseTabs = (params.GetInt(1) & 16)?1:0;
		aValues.append = (params.GetInt(1) & 32)?1:0;
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
	// If the session list is not formatted correctly an error will be dump to the console using the "dump"
	// function and the session select window will not be displayed.
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

	sanitize: function()
	{
		// If Sanitize GUI not used (or not Firefox 3.1 and above)
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
			if (dirname != "") {
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
		// allow overriding of location of sessions directory
		var dir = this.getUserDir("sessions");
			
		// use default is not specified or not a writable directory
		if (dir == null) {
			dir = this.getProfileFile("sessions");
		}
		if (!dir.exists())
		{
			dir.create(this.mComponents.interfaces.nsIFile.DIRECTORY_TYPE, 0700);
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
	},

	//
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	//
	getSessions: function(filter)
	{
		var matchArray;
		var sessions = [];
		var trueUpdate = false;
		sessions.latestTime = sessions.latestBackUpTime = 0;
		
		var filesEnum = this.getSessionDir().directoryEntries.QueryInterface(this.mComponents.interfaces.nsISimpleEnumerator);
		while (filesEnum.hasMoreElements())
		{
			var file = filesEnum.getNext().QueryInterface(this.mComponents.interfaces.nsIFile);
			// don't try to read a directory
			if (file.isDirectory()) continue;
			var fileName = file.leafName;
			var backupItem = (this.mBackupSessionRegEx.test(fileName) || (fileName == this.mAutoSaveSessionName));
			var cached = this.mSessionCache[fileName] || null;
			if (cached && cached.time == file.lastModifiedTime)
			{
				try {
					if (filter && !filter.test(cached.name)) continue;
				} catch(ex) { 
					dump ("Session Manager: Bad Regular Expression passed to getSessions, ignoring\n"); 
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
					dump ("Session Manager: Bad Regular Expression passed to getSessions, ignoring\n"); 
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
				this.mSessionCache[fileName] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group };
				
				// update last file modified time
				if (this.mSessionCache.timestamp < file.lastModifiedTime) this.mSessionCache.timestamp = file.lastModifiedTime;
				trueUpdate = true;
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
		
		// Notify all other open windows so they can copy the session list cache - this minimizes disk reads
		//dump("Needed to read disk is " + (trueUpdate?"true\n":"false\n"));
		if (trueUpdate) this.mObserverService.notifyObservers(window, "sessionmanager-list-update", null);
		return (this.mPref_session_list_order < 0)?sessions.reverse():sessions;
	},

	getClosedWindows: function()
	{
		// Use cached data unless file has changed or was deleted
		var data = this.mClosedWindowsCache.data;
		var file = this.getProfileFile(this.mClosedWindowFile);
		if (!file.exists()) return [];
		else if (file.lastModifiedTime > this.mClosedWindowsCache.timestamp) {
			data = this.readFile(this.getProfileFile(this.mClosedWindowFile));
			this.mClosedWindowsCache.data = data;
			if (data) this.mClosedWindowsCache.timestamp = file.lastModifiedTime;
		}
		return (data)?data.split("\n\n").map(function(aEntry) {
			var parts = aEntry.split("\n");
			return { name: parts.shift(), state: parts.join("\n") };
		}):[];
	},

	storeClosedWindows: function(aList)
	{
		var file = this.getProfileFile(this.mClosedWindowFile);
		if (aList.length > 0)
		{
			var data = aList.map(function(aEntry) {
				return aEntry.name + "\n" + aEntry.state
			}).join("\n\n");
			this.writeFile(file, data);
			this.mClosedWindowsCache.data = data;
			this.mClosedWindowsCache.timestamp = file.lastModifiedTime;
		}
		else
		{
			this.delFile(file);
			this.mClosedWindowsCache.data = null;
			this.mClosedWindowsCache.timestamp = 0;
		}
		
		// Firefox 2.0 will throw an exception if getClosedTabCount is called for a closed window so just fake it
		// if mLastState is set, because parameter will always be true in that case.
		if (this.mLastState) this.updateToolbarButton(true);
		else this.updateToolbarButton(aList.length + this.mSessionStore().getClosedTabCount(window)  > 0);
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
		var windows = this.getClosedWindows();
		
		// encrypt state if encryption preference set
		if (this.mPref_encrypt_sessions) {
			aState = this.decryptEncryptByPreference(aState);
			if (!aState) return;
		}
				
		aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
		windows.unshift({ name: name, state: aState });
		this.storeClosedWindows(windows.slice(0, this.mPref_max_closed_undo));
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
		// Make sure to pull in fresh state data at shut down
		this.mLastState = null;
		this.mCleanBrowser = null;
		this.mClosedWindowName = null;
		
		// Handle sanitizing if sanitize on shutdown without prompting
		if ((this.getPref("privacy.sanitize.sanitizeOnShutdown", false, true)) &&
			(!this.getPref("privacy.sanitize.promptOnSanitize", true, true)) &&
			(this.getPref("privacy.item.extensions-sessionmanager", false, true)))
		{
			this.sanitize();
		}
		// otherwise
		else
		{
			if (!this.mPref_save_window_list)
			{
				this.clearUndoData("window", true, true);
			}
		
			// save the currently opened session (if there is one)
			if (!this.closeSession(false))
			{
				if (!this.isPrivateBrowserMode()) this.backupCurrentSession();
			}
			else
			{
				if (!this.isPrivateBrowserMode()) this.keepOldBackups(false);
			}
			
			this.delFile(this.getSessionDir(this.mAutoSaveSessionName), true);
		}
		
		this.delPref("_running");
		this.delPref("_autosave_values");
		this.delPref("_encrypt_file");
		this.delPref("_recovering");
		this.mPref__running = false;

		// Cleanup left over files from Crash Recovery
		if (this.getPref("extensions.crashrecovery.resume_session_once", false, true))
		{	
			this.delFile(this.getProfileFile("crashrecovery.dat"), true);
			this.delFile(this.getProfileFile("crashrecovery.bak"), true);
			this.delPref("extensions.crashrecovery.resume_session_once", true);
		}
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
		var backup = this.mPref_backup_session;
		var temp_backup = (this.mPref_startup > 0) && (this.mPref_resume_session == this.mBackupSessionName);
		
		// Don't save if just a blank window, if there's an error parsing data, just save
		var state = null;
		if ((backup > 0) || temp_backup) {
			state = this.getSessionState(this._string_backup_session || this._string("backup_session"), null, null, null, (this._string_backup_sessions || this._string("backup_sessions")), true);
			try {
				var aState = this.JSON_decode(state.split("\n")[4]);
				if (!((aState.windows.length > 1) || (aState.windows[0]._closedTabs.length > 0) || (aState.windows[0].tabs.length > 1) || 
		    		(aState.windows[0].tabs[0].entries.length > 1) || 
		    		((aState.windows[0].tabs[0].entries.length == 1 && aState.windows[0].tabs[0].entries[0].url != "about:blank")))) {
					backup = 0;
					temp_backup = false;
				}
			} catch(ex) { dump(ex); }
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
					this.synchStartup();
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
			}
		}
		else this.keepOldBackups(false);
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
			state = "[SessionManager]\nname=" + name + "\ntimestamp=" + timestamp + "\nautosave=false" + countString + state;
			this.writeFile(aFile, state);
		}
		// Not latest session format
		else if ((/^\[SessionManager\]\nname=.*\ntimestamp=\d+\n/m.test(state)) && (!this.mSessionRegExp.test(state)))
		{
			// This should always match, but is required to get the RegExp values set correctly.
			// RegExp.$1 - Entire 4 line header
			// RegExp.$2 - Top 3 lines (includes name and timestamp)
			// RegExp.$3 - Autosave string (if it exists)
			// RegExp.$4 - Autosave value (not really used at the moment)
			// RegExp.$5 - Count string (if it exists)
			// RegExp.$6 - Group string and any invalid count string before (if either exists)
			// RegExp.$7 - Invalid count string (if it exists)
			// RegExp.$8 - Group string (if it exists)
			if (/((^\[SessionManager\]\nname=.*\ntimestamp=\d+\n)(autosave=(false|true|session\/?\d*|window)[\n]?)?(\tcount=[1-9][0-9]*\/[1-9][0-9]*[\n]?)?((\t.*)?(\tgroup=.+\n))?)/m.test(state))
			{	
				var header = RegExp.$1;
				var nameTime = RegExp.$2;
				var auto = RegExp.$3;
				var autoValue = RegExp.$4;
				var count = RegExp.$5;
				var group = RegExp.$8 ? RegExp.$8 : "";
				var goodSession = true;

				// If two autosave lines, session file is bad so try and fix it (shouldn't happen anymore)
				if (/autosave=(false|true|session\/?\d*|window).*\nautosave=(false|true|session\/?\d*|window)/m.test(state)) {
					goodSession = false;
				}
				
				// read entire file if only read header
				if (headerOnly) state = this.readFile(aFile);

				if (goodSession)
				{
					var data = state.split("\n")[((auto) ? 4 : 3)];
					data = this.decrypt(data, true);
					if (!data) {
						// master password entered, but still could not be encrypted - either corrupt or saved under different profile
						if (data == false) {
							this.moveToCorruptFolder(aFile);
						}
						return null;
					}
					var countString = (count) ? (count) : getCountString(this.getCount(data));
					// remove \n from count string if group is there
					if (group && (countString[countString.length-1] == "\n")) countString = countString.substring(0, countString.length - 1);
					var autoSaveString = (auto) ? (auto).split("\n")[0] : "autosave=false";
					if (autoSaveString == "autosave=true") autoSaveString = "autosave=session/";
					state = nameTime + autoSaveString + countString + group + this.decryptEncryptByPreference(data);
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
					if (RegExp.$5 == "\tcount=0/0") newstate.splice(3,1);
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
		if (aFile.exists())
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

	decrypt: function(aData, aNoError)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		if (aData.indexOf(":") == -1)
		{
			try {
				aData = this.mSecretDecoderRing.decryptString(aData);
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
		var encrypted = (aData.indexOf(":") == -1);
		try {
			if (this.mPref_encrypt_sessions && !encrypted)
			{
				aData = this.mSecretDecoderRing.encryptString(aData);
			}
			else if (!this.mPref_encrypt_sessions && encrypted)
			{
				aData = this.mSecretDecoderRing.decryptString(aData);
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
		
			var windows = this.getClosedWindows();
			windows.forEach(function(aWindow) {
				aWindow.state = this.decryptEncryptByPreference(aWindow.state);
			}, this);
			this.storeClosedWindows(windows);
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
		var names = [ "_running", "_autosave_values" ];
		
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

	// Read Autosave values from preference and store into global variables
	getAutoSaveValues: function(aValues)
	{
		var values = aValues.split("\n");
		this.mPref__autosave_name = values[0];
		this.mPref__autosave_group = values[1];
		this.mPref__autosave_time = isNaN(values[2]) ? 0 : values[2] ;
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
	tryToSanitize: function ()
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
		
	synchStartup: function(aData)
	{
		var browser_startup = this.getPref("browser.startup.page", 1, true);
		var sm_startup = this.getPref("startup", 0);

		// browser currently sent to resume browser session and Session Manager thinks it's handling sessions
		if (browser_startup >= 2 && sm_startup) {
			if (aData == "page") this.setPref("startup",0);
			else this.setPref("browser.startup.page",  this.getPref("old_startup_page",1), true);
		}
		else if (browser_startup < 2) this.setPref("old_startup_page", browser_startup);
	},

	recoverSession: function()
	{
		var recovering = this.getPref("_recovering");
		// Use SessionStart's value in FF3 because preference is cleared by the time we are called, in FF2 SessionStart doesn't set this value
		var sessionstart = (this.mAppVersion >= "1.9")
		                    ?(this.mSessionStartupValue.sessionType != Components.interfaces.nsISessionStartup.NO_SESSION)
		                    :this.getPref("browser.sessionstore.resume_session_once", false, true);
		var recoverOnly = this.mPref__running || sessionstart;
		// handle crash where user chose a specific session
		if (recovering)
		{
			var choseTabs = false;
			choseTabs = this.getPref("_chose_tabs");
			this.delPref("_recovering");
			this.delPref("_chose_tabs"); // delete chose tabs preference if set
			this.load(recovering, "startup", choseTabs);
		}
		else if (!recoverOnly && (this.mPref_restore_temporary || (this.mPref_startup == 1) || ((this.mPref_startup == 2) && this.mPref_resume_session)) && this.getSessions().length > 0)
		{
			// allow prompting for tabs in Firefox 3.1
			var values = { ignorable: true };
			
			var session = (this.mPref_restore_temporary)?this.mBackupSessionName:((this.mPref_startup == 1)?this.selectSession(this._string("resume_session"), this._string("resume_session_ok"), values):this.mPref_resume_session);
			if (session && this.getSessionDir(session).exists())
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
		}
		// handle browser reload with same session and when opening new windows
		else if (recoverOnly) {
			this.checkTimer();
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
		return (!window.arguments || window.arguments.length <= 1);
	},
	
	isPrivateBrowserMode: function()
	{
		// This is only available in Firefox 3.1 and above
		try {
			return Components.classes["@mozilla.org/privatebrowsing;1"].
					getService(Components.interfaces.nsIPrivateBrowsingService).privateBrowsingEnabled;
		}
		catch(ex) {
			return false;
		}
	},

	updateToolbarButton: function(aEnable)
	{
		var button = (document)?document.getElementById("sessionmanager-undo"):null;
		if (button)
		{
			var tabcount = 0;
			try {
				tabcount = this.mSessionStore().getClosedTabCount(window);
			} catch (ex) {}
			this.setDisabled(button, (aEnable != undefined)?!aEnable:tabcount == 0 && this.getClosedWindows().length == 0);
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
		if ((this._timer) && ((this.mPref__autosave_time <= 0) || (this.mPref__autosave_name == ""))) {
			this._timer.cancel();
			this._timer = null;
			//dump("Timer stopped\n");
		}
		else if (!this._timer && (this.mPref__autosave_time > 0) && (this.mPref__autosave_name != "")) {
			//dump("Check if timer already running and if not start it\n");
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
				//dump("Timer started for " + this.mPref__autosave_time + " minutes\n");
			}
		}
	},
	
/* ........ Auxiliary Functions .............. */
	// Undo closed tab function for SeaMonkey
	undoCloseTabSM: function (aIndex)
	{
		if (gSessionManager.mSessionStore().getClosedTabCount(window) == 0)	return;
		gSessionManager.mSessionStore().undoCloseTab(window, aIndex || 0);
		// Only need to check for empty close tab list if possibly re-opening last closed tabs
		if (!aIndex) gSessionManager.updateToolbarButton();
	},

	// count windows and tabs
	getCount: function (aState)
	{
		var windows = 0, tabs = 0;
		
		try {
			aState = this.JSON_decode(aState);
			aState.windows.forEach(function(aWindow) {
				windows = windows + 1;
				tabs = tabs + aWindow.tabs.length;
			});
		}
		catch (ex) { dump(ex + "\n"); };

		return { windows: windows, tabs: tabs };
	},
	
	// Work around for bug 350558 which mangles the _closedTabs.state.entries 
	// and tabs.entries array data in Firefox 2.0.x
	fixBug350558: function (aTabs)
	{
		aTabs.forEach(function(bValue, bIndex) {
			// Closed Tabs
			if (bValue.state) {
				// If "fake" array exists, make it a real one
				if (!(bValue.state.entries instanceof Array))
				{
					var oldEntries = bValue.state.entries;
					bValue.state.entries = [];
					for (var i = 0; oldEntries[i]; i++) {
						bValue.state.entries[i] = oldEntries[i];
					}
				}
			}
			// Open Tabs
			else {
				// If "fake" array exists, make it a real one
				if (!(bValue.entries instanceof Array))
				{
					var oldEntries = bValue.entries;
					bValue.entries = [];
					for (var i = 0; oldEntries[i]; i++) {
						bValue.entries[i] = oldEntries[i];
					}
				}
			}
		});
	},

	getSessionState: function(aName, aOneWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime)
	{
		// Return last closed window state if it is stored.
		if (this.mLastState) {
			//dump("Returning stored state\n");
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
		
		var state = (aOneWindow)?this.mSessionStore().getWindowState(window):this.mSessionStore().getBrowserState();
		
		state = this.modifySessionData(state, aNoUndoData, true, (this.mAppVersion < "1.9"));
		var count = this.getCount(state);
		
		// encrypt state if encryption preference set and flag not set
		if (!aDoNotEncrypt) {
			state = this.decryptEncryptByPreference(state); 
			if (!state) return null;
		}
		
		return (aName != null)?this.nameState(("[SessionManager]\nname=" + (new Date()).toString() + "\ntimestamp=" + Date.now() + 
				"\nautosave=" + ((aAutoSave)?("session/" + aAutoSaveTime):"false") + "\tcount=" + count.windows + "/" + count.tabs + 
				(aGroup? ("\tgroup=" + aGroup) : "") + "\n" + state + "\n").replace(/\n\[/g, "\n$&"), aName || ""):state;
	},

	restoreSession: function(aWindow, aState, aReplaceTabs, aStripClosedTabs, aEntireSession, aOneWindow)
	{
		// decrypt state if encrypted
		aState = this.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = this.openWindow(this.getPref("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				this.gSessionManager.restoreSession(this, aState, aReplaceTabs, aStripClosedTabs);
				this.gSessionManager.__window_session_name = unescape(this.gSessionManager.mSessionStore().getWindowValue(aWindow,"_sm_window_session_name"));
				//dump("restore win " + this.gSessionManager.__window_session_name + "\n");
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		//Try and fix bug35058 even in newer versions of Firefox, because session might have been saved under FF 2.0
		aState = this.modifySessionData(aState, aStripClosedTabs, false, true, aEntireSession);  

		if (aEntireSession)
		{
			this.mSessionStore().setBrowserState(aState);
		}
		else
		{
			if (!aReplaceTabs || aOneWindow) aState = this.makeOneWindow(aState);
			this.mSessionStore().setWindowState(aWindow, aState, aReplaceTabs || false);
		}
		//this.__window_session_name = unescape(this.mSessionStore().getWindowValue(window,"_sm_window_session_name"));
		//dump("restore done " + this.__window_session_name + "\n");
		return true;
	},

	nameState: function(aState, aName)
	{
		if (!/^\[SessionManager\]/m.test(aState))
		{
			return "[SessionManager]\nname=" + aName + "\n" + aState;
		}
		return aState.replace(/^(\[SessionManager\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName; });
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
	
	modifySessionData: function(aState, aStrip, aSaving, afixBug350558, aReplacingWindow)
	{
		aState = this.JSON_decode(aState);
		aState.windows.forEach(function(aWindow) {
			// Strip out cookies if user doesn't want to save them
			if (aSaving && !this.mPref_save_cookies) delete(aWindow.cookies);

			// Either remove or fix closed tabs			
			if (aStrip) aWindow._closedTabs = [];
			else if (afixBug350558) this.fixBug350558(aWindow._closedTabs);

			// Work around for bug 350558 which mangles the _closedTabs.state.entries 
			// and tabs.entries array data in Firefox 2.0.x
			if (afixBug350558) this.fixBug350558(aWindow.tabs);
		}, this);
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
		var windowSessions = {};
		this.getBrowserWindows().forEach(function(aWindow) {
			if (aWindow.gSessionManager && aWindow.gSessionManager.__window_session_name && aWindow.gSessionManager.__window_session_name != "") { 
				windowSessions[aWindow.gSessionManager.__window_session_name.trim().toLowerCase()] = true;
			}
		});
		return windowSessions;
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

	doResumeCurrent: function()
	{
		return (this.getPref("browser.startup.page", 1, true) == 3)?true:false;
	},

	setResumeCurrent: function(aValue)
	{
		if (aValue) this.setPref("browser.startup.page", 3, true);
		else this.setPref("browser.startup.page", this.getPref("old_startup_page", 1), true);
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

	/**
	* Converts a JavaScript object into a JSON string
	* (see http://www.json.org/ for the full grammar).  Only used in Firefox 2.0
	*
	* The inverse operation consists of eval("(" + JSON_string + ")");
	* and should be provably safe.
	*
	* @param aJSObject is the object to be converted
	* @return the object's JSON representation
	*/
	toJSONString: function toJSONString(aJSObject) {
		// these characters have a special escape notation
		const charMap = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f",
		                  "\r": "\\r", '"': '\\"', "\\": "\\\\" };
		// we use a single string builder for efficiency reasons
		var parts = [];
		
		// this recursive function walks through all objects and appends their
		// JSON representation to the string builder
		function jsonIfy(aObj) {
			if (typeof aObj == "boolean") {
				parts.push(aObj ? "true" : "false");
			}
			else if (typeof aObj == "number" && isFinite(aObj)) {
				// there is no representation for infinite numbers or for NaN!
				parts.push(aObj.toString());
			}
			else if (typeof aObj == "string") {
				aObj = aObj.replace(/[\\"\x00-\x1F\u0080-\uFFFF]/g, function($0) {
				// use the special escape notation if one exists, otherwise
				// produce a general unicode escape sequence
				return charMap[$0] ||
					"\\u" + ("0000" + $0.charCodeAt(0).toString(16)).slice(-4);
				});
				parts.push('"' + aObj + '"')
			}
			else if (aObj == null) {
				parts.push("null");
			}
			// if it looks like an array, treat it as such -
			// this is required for all arrays from a sandbox
			else if (aObj instanceof Array ||
					typeof aObj == "object" && "length" in aObj &&
					(aObj.length === 0 || aObj[aObj.length - 1] !== undefined)) {
				parts.push("[");
				for (var i = 0; i < aObj.length; i++) {
					jsonIfy(aObj[i]);
					parts.push(",");
				}
				if (parts[parts.length - 1] == ",")
					parts.pop(); // drop the trailing colon
				parts.push("]");
			}
			else if (typeof aObj == "object") {
				parts.push("{");
				for (var key in aObj) {
					if (key == "_tab")
						continue; // XXXzeniko we might even want to drop all private members
			
					jsonIfy(key.toString());
					parts.push(":");
					jsonIfy(aObj[key]);
					parts.push(",");
				}
				if (parts[parts.length - 1] == ",")
					parts.pop(); // drop the trailing colon
				parts.push("}");
			}
			else {
				throw new Error("No JSON representation for this object!");
			}
		}
		jsonIfy(aJSObject);
		
		var newJSONString = parts.join(" ");
		// sanity check - so that API consumers can just eval this string
		if (/[^,:{}\[\]0-9.\-+Eaeflnr-u \n\r\t]/.test(
			newJSONString.replace(/"(\\.|[^"\\])*"/g, "")
		))
		throw new Error("JSON conversion failed unexpectedly!");
		
		return newJSONString;
	},
	
	// Decode JSON string to javascript object - use JSON if built-in.
	JSON_decode: function(aStr) {
		var jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }] };
		try {
			var hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
			var builtInJSON = typeof(JSON) != "undefined";
		
			// JSON can't parse when string is wrapped in parenthesis
			if (builtInJSON && hasParens) {
				aStr = aStr.substring(1, aStr.length - 1);
			}
		
			if (builtInJSON) {
				// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
				try {
					jsObject = JSON.parse(aStr);
				}
				catch (ex) {
					jsObject = this.mComponents.utils.evalInSandbox("(" + aStr + ")", new this.mComponents.utils.Sandbox("about:blank"));
				}
			}
			else {
				jsObject = this.mComponents.utils.evalInSandbox("(" + aStr + ")", new this.mComponents.utils.Sandbox("about:blank"));
			}
		}
		catch(ex) {
			this.sessionError(ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function(aObj) {
		var jsString = null;
		try {
			if (typeof(JSON) != "undefined") {
				jsString = JSON.stringify(aObj);
			}
			else if (this.mComponents.classes["@mozilla.org/dom/json;1"]) {
				var nativeJSON = this.mComponents.classes["@mozilla.org/dom/json;1"].createInstance(this.mComponents.interfaces.nsIJSON);
				jsString = nativeJSON.encode(aObj);
			}
			else {
				jsString = this.toJSONString(aObj);
			}
		}
		catch(ex) {
			this.sessionError(ex);
		}
		return jsString;
	}
};

String.prototype.trim = function() {
	return this.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ");
};

window.addEventListener("load", gSessionManager.onLoad_proxy, false);
