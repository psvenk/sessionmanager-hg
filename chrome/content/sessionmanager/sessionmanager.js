const SM_VERSION = "0.6.2.1";

/*const*/ var gSessionManager = {
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

	mObserving: ["sessionmanager:windowtabopenclose", "sessionmanager:updatetitlebar", "browser:purge-session-history", "quit-application-granted"],
	mClosedWindowFile: "sessionmanager.dat",
	mBackupSessionName: "backup.session",
	mBackupSessionRegEx: /^backup(-[1-9](\d)*)?\.session$/,
	mAutoSaveSessionName: "autosave.session",
	mSessionExt: ".session",
	mFirstUrl: "http://sessionmanager.mozdev.org/documentation.html",
	mSessionRegExp: /^\[SessionManager\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session|window)\tcount=([1-9][0-9]*)\/([1-9][0-9]*)/m,

	mSessionCache: { timestamp: 0 },
	mClosedWindowsCache: { timestamp: 0, data: null },
	
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
			else if (this.mComponents.classes["@mozilla.org/suite/sessionstore ;1"]) {
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
					window.addEventListener("unload", gSessionManager.onUnload_Uninstall, false);
				}
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
		
		// Determine Mozilla version to see what is supported
		this.mAppVersion = "0";
		try {
			this.mAppVersion = Components.classes["@mozilla.org/xre/app-info;1"].
			                   getService(Components.interfaces.nsIXULAppInfo).platformVersion;
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
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.addObserver(this, aTopic, false);
		}, this);
		this.mObserverService.addObserver(this, "quit-application", false);
		this.mObserverService.addObserver(this, "sessionmanager-list-update", false);
		// The following is needed to handle extensions who issue bad restarts in Firefox 2.0
		if (this.mAppVersion < "1.9") this.mObserverService.addObserver(this, "quit-application-requested", false);
		
		this.mPref_autosave_session = this.getPref("autosave_session", true);
		this.mPref_backup_session = this.getPref("backup_session", 1);
		this.mPref_click_restore_tab = this.getPref("click_restore_tab", true);
		this.mPref_encrypt_sessions = this.getPref("encrypt_sessions", false);
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
		this.mPref_hide_tools_menu = this.getPref("hide_tools_menu", false);
		this.mPref_startup = this.getPref("startup",0);
		this.mPref_submenus = this.getPref("submenus", false);
		this.mPref__running = this.getPref("_running", false);
		this.mPref__autosave_name = this.getPref("_autosave_name", "");
		this.mPrefBranch.addObserver("", this, false);
		this.mPrefBranch2.addObserver("page", this, false);
		
		gBrowser.addEventListener("TabClose", this.onTabClose_proxy, false);
		gBrowser.addEventListener("SSTabRestored", this.onTabRestored_proxy, false);
		
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
			this.mPrefRoot.savePrefFile(null);
		}
		this.mFullyLoaded = true;
		
		// Add sessionname to title when browser updates titlebar. Need to hook browser since 
		// DOMTitleChanged doesn't fire every time the title changes in the titlebar.
		eval("gBrowser.updateTitlebar = " + gBrowser.updateTitlebar.toString().replace("this.ownerDocument.title = newTitle;", "$&gSessionManager.updateTitlebar();"));
		gBrowser.updateTitlebar();

		// Workaround for bug 366986
		// TabClose event fires too late to use SetTabValue to save the "image" attribute value and have it be saved by SessionStore
		// so make the image tag persistant so it can be read later from the xultab variable.
		this.mSessionStore().persistTabAttribute("image");
		
		// Workaround for bug 360408 in Firefox 2.0, remove when fixed and uncomment call to onWindowClose in onUnload
		if (this.mAppVersion < "1.9") eval("closeWindow = " + closeWindow.toString().replace("if (aClose)", "gSessionManager.onWindowClose(); $&"));
		
		// Have Tab Mix Plus call our function to update our toolbar button.
		if (gBrowser.undoRemoveTab)
		{
			eval("gBrowser.undoRemoveTab = " + gBrowser.undoRemoveTab.toString().replace("return this", "gSessionManager.mObserverService.notifyObservers(window, 'sessionmanager:windowtabopenclose', 'tab'); $&"));
		}
		
		// Don't allow tab to reload when restoring closed tab
		if (undoCloseTab) {
			eval("undoCloseTab = " + undoCloseTab.toString().replace("var tabbrowser", "window.gSessionManager._allowReload = false; $&"));
		}
		// SeaMonkey doesn't have an undoCloseTab function so create one
		else {
			eval("undoCloseTab = gSessionManager.undoCloseTabSM");
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
		
		// One time message on update
		if (this.getPref("version", "") != SM_VERSION)
		{
			this.setPref("version", SM_VERSION);
			setTimeout(function() {
				var tBrowser = getBrowser();
				tBrowser.selectedTab = tBrowser.addTab(gSessionManager.mFirstUrl);
			},100);
			
			// Clean out screenX and screenY persist values from localstore.rdf since we don't persist anymore.
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
	},

	// If uninstalling because of incompatability remove preference
	onUnload_Uninstall: function()
	{
		this.removeEventListener("unload", gSessionManager.onUnload_Uninstall, false);
		gSessionManager.delPref("browser.sessionmanager.uninstalled", true);
	},
	
	onUnload_proxy: function()
	{
		this.removeEventListener("unload", gSessionManager.onUnload_proxy, false);
		gSessionManager.onUnload();
	},

	onUnload: function()
	{
		var numWindows = this.getBrowserWindows().length;
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.removeObserver(this, aTopic);
		}, this);
		this.mObserverService.removeObserver(this, "sessionmanager-list-update");
		this.mPrefBranch.removeObserver("", this);
		this.mPrefBranch2.removeObserver("page", this);
		
		gBrowser.removeEventListener("TabClose", this.onTabClose_proxy, false);
		gBrowser.removeEventListener("SSTabRestored", this.onTabRestored_proxy, false);
		gBrowser.mStrip.removeEventListener("click", this.onTabBarClick, false);
		
		// Last window closing will leaks briefly since "quit-application" observer is not removed from it 
		// until after shutdown is run, but since browser is closing anyway, who cares?
		if (numWindows != 0) this.mObserverService.removeObserver(this, "quit-application");

		// Only do the following in Firefox 3.0 and above where bug 360408 is fixed.
		if (this.mAppVersion >= "1.9") this.onWindowClose();
				
		if (this.mPref__running && numWindows == 0)
		{
			this._string_preserve_session = this._string("preserve_session");
			this._string_backup_session = this._string("backup_session");
			this._string_old_backup_session = this._string("old_backup_session");
			this._string_prompt_not_again = this._string("prompt_not_again");
			this._string_encrypt_fail = this._string("encrypt_fail");
			this._string_save_and_restore = this._string("save_and_restore");
			
			this.mTitle += " - " + document.getElementById("bundle_brand").getString("brandFullName");
			this.mBundle = null;
			
			// This executes in Firefox 2.x if last browser window closes and non-browser windows are still open
			// or if Firefox is restarted. In Firefox 3.0, it executes whenever the last browser window is closed.
			if (!this.mPref__stopping) {
				this.mObserverService.removeObserver(this, "quit-application");
				this.shutDown();
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
		case "sessionmanager:updatetitlebar":
			gBrowser.updateTitlebar();
			break;
		case "browser:purge-session-history":
			this.clearUndoData("all");
			break;
		case "sessionmanager-list-update":
			// this session cache from updated window so this window doesn't need to read from disk
			if (window != aSubject) {
				if (this.mSessionCache.timestamp < aSubject.gSessionManager.mSessionCache.timestamp) {
					//dump("Updating window " + window.title + "\n");
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
			case "_autosave_name":
				this.mSessionStore().setWindowValue(window,"_sm_autosave_name",escape(this.mPref__autosave_name));
				gBrowser.updateTitlebar();
				break;
			case "hide_tools_menu":
				this.showHideToolsMenu();
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
			this.mObserverService.removeObserver(this, "quit-application");
			// only run shutdown for one window and if not restarting browser
			if (aData != "restart")
			{
				this.shutDown();
			}
			else
			{
				// don't reload tabs after restart
				this.setPref("_no_reload", true);
			}
			break;
		case "quit-application-granted":
			// quit granted so stop listening for closed windows
			this.mPref__stopping = true;
			this._mUserDirectory = this.getUserDir("sessions");
			break;
		}
	},

	onTabClose_proxy: function(aEvent)
	{
		gSessionManager.mObserverService.notifyObservers(window, "sessionmanager:windowtabopenclose", "tab");
	},

	onTabRestored_proxy: function(aEvent)
	{
		var browser = this.getBrowserForTab(aEvent.originalTarget);

		if (gSessionManager.mPref_reload && gSessionManager._allowReload && !gSessionManager.mIOService.offline)
		{
			var nsIWebNavigation = Components.interfaces.nsIWebNavigation;
			browser.reloadWithFlags(nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
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
			eval("var event = { shiftKey: true }; " + aButton.getAttribute("oncommand"));
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
			// Don't need to save autosave name in FF 3.0+ since when closed window is restored it will be overwritten
			// and it will cause an exception if window's data has been wiped.
			if (this.mAppVersion < "1.9") this.mSessionStore().setWindowValue(window,"_sm_autosave_name","");
		}
			
		if (this.mPref__running && !this.mPref__stopping && this.getBrowserWindows().length != 0)
		{
			// Don't need to save autosave name in FF 3.0+ since when closed window is restored it will be overwritten
			// and it will cause an exception if window's data has been wiped.
			if (this.mAppVersion < "1.9") this.mSessionStore().setWindowValue(window,"_sm_autosave_name","");
			var state = this.getSessionState(null, true);
			this.appendClosedWindow(state);
			this.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);
		}
	},
	
	// Put current session name in browser titlebar
	updateTitlebar: function()
	{
		// Don't kill browser if something goes wrong
		try {
			var sessionTitleName = (this.mPref__autosave_name) ? (" - (" + this._string("current_session2") + " " + this.mPref__autosave_name + ")") : "";
			var windowTitleName = (this.__window_session_name) ? (" - (" + this._string("current_session2") + " " + this.__window_session_name + ")") : "";
		
			// Add window and browser session titles
			gBrowser.ownerDocument.title = gBrowser.ownerDocument.title.replace(/(- \(([^:|.]*): ([^:|.]*)\)+( - \(([^:|.]*): ([^:|.]*)\))*)?$/, windowTitleName + sessionTitleName);
		} catch (ex) { dump(ex); }
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
		
		var windowSessions = this.getWindowSessions();
		var sessions = this.getSessions(true);
		var count = 0;
		var backupCount = 0;
		sessions.forEach(function(aSession, aIx) {
			if (!aSession.backup && (this.mPref_max_display >= 0) && (count >= this.mPref_max_display)) return;
	
			var key = aSession.backup?"":(++count < 10)?count:(count == 10)?"0":"";
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", ((key)?key + ") ":"") + aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("oncommand", 'gSessionManager.load("' + aSession.fileName + '", (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.shiftKey)?"newwindow":(event.ctrlKey || event.metaKey)?"append":"");');
			menuitem.setAttribute("onclick", 'if (event.button == 1) gSessionManager.load("' + aSession.fileName + '", "newwindow");');
			menuitem.setAttribute("contextmenu", "sessionmanager-ContextMenu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("accesskey", key);
			menuitem.setAttribute("autosave", aSession.autosave);
			menuitem.setAttribute("disabled", windowSessions[aSession.name.trim().toLowerCase()] || false);
			if (sessions.latestTime == aSession.timestamp) menuitem.setAttribute("latest", true);
			if (sessions.latestBackUpTime == aSession.timestamp) menuitem.setAttribute("latest", true);
			if (aSession.name == this.mPref__autosave_name) menuitem.setAttribute("disabled", true);
			if (aSession.backup) {
				backupCount++;
				backupPopup.appendChild(menuitem);
			}
			else {
				aPopup.insertBefore(menuitem, separator);
			}
		}, this);
		backupSep.hidden = backupMenu.hidden = (backupCount == 0);
		separator.hidden = (this.mPref_max_display == 0) || ((sessions.length - backupCount) == 0);
		this.setDisabled(separator.nextSibling, separator.hidden && backupSep.hidden);
		this.setDisabled(separator.nextSibling.nextSibling, separator.hidden && backupSep.hidden);
		
		try
		{
			get_("resume").setAttribute("checked", this.doResumeCurrent());
			get_("overwrite").setAttribute("checked", this.mPref_overwrite);
			get_("reload").setAttribute("checked", this.mPref_reload);
		}
		catch (ex) { } // not available for Firefox
		
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

	save: function(aName, aFileName, aOneWindow)
	{
		var values = { text: this.getFormattedName(content.document.title || "about:blank", new Date()) || (new Date()).toLocaleString(), autoSaveable : true };
		if (!aName)
		{
			if (!this.prompt(this._string("save2_session"), this._string("save_" + ((aOneWindow)?"window":"session") + "_ok"), values, this._string("save_" + ((aOneWindow)?"window":"session")), this._string("save_session_ok2")))
			{
				return;
			}
			aName = values.text;
			aFileName = values.name;
		}
		if (aName)
		{
//			if (aOneWindow) this.mSessionStore().setWindowValue(window,"_sm_window_session_name",(values.autoSave)?escape(aName):"");
			
			var file = this.getSessionDir(aFileName || this.makeFileName(aName), !aFileName);
			try
			{
				this.writeFile(file, this.getSessionState(aName, aOneWindow, this.mPref_save_closed_tabs < 2, values.autoSave));
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
				this.setPref("_autosave_name",aName);
			}
			else if (this.mPref__autosave_name == aName)
			{
				// If in auto-save session and user saves on top of it as manual turn off autosave
				this.setPref("_autosave_name","");
			}
//		}
//		else 
//		{
//			this.__window_session_name = (values.autoSave) ? aName : null;
//			gBrowser.updateTitlebar();
//		}
	},

	saveWindow: function(aName, aFileName)
	{
		this.save(aName, aFileName, true);
	},
	
	// if aOneWindow is true, then close the window session otherwise close the browser session
	closeSession: function(aOneWindow)
	{
		var name = (aOneWindow) ? this.__window_session_name : this.mPref__autosave_name;
		if (name != "")
		{
			var file = this.getSessionDir(this.makeFileName(name));
			try
			{
				this.writeFile(file, this.getSessionState(name, aOneWindow, this.mPref_save_closed_tabs < 2, true));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		
			if (!aOneWindow) this.setPref("_autosave_name","");
			else this.__window_session_name = null;
			return true;
		}
		return false;
	},
	
	abandonSession: function()
	{
		var dontPrompt = { value: false };
		if (this.getPref("no_abandon_prompt") || this.mPromptService.confirmEx(null, this.mTitle, this._string("abandom_prompt"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			this.setPref("_autosave_name","");
			if (dontPrompt.value)
			{
				this.setPref("no_abandon_prompt", true);
			}
		}
	},

	load: function(aFileName, aMode)
	{
		var state = this.readSessionFile(this.getSessionDir(aFileName));
		if (!state)
		{
			this.ioError();
			return;
		}

		if (this.mSessionRegExp.test(state))
		{
			var name = RegExp.$1;
			var autosave = RegExp.$3;
			state = state.split("\n")[4];
			
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
			
			// If this is an autosave session, keep track of it if there is not already an active session
			if (autosave == "session" && this.mPref__autosave_name=="") 
			{
				this.setPref("_autosave_name", name);
			}
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

		setTimeout(function() {
			var tabcount = gBrowser.mTabs.length;
			var okay = gSessionManager.restoreSession((!newWindow)?window:null, state, overwriteTabs, true, stripClosedTabs, (overwriteTabs && !newWindow && !TMP_SingleWindowMode), TMP_SingleWindowMode);
			if (okay) {
				gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:windowtabopenclose", null);

				if (tabsToMove)
				{
					var endPos = gBrowser.mTabs.length - 1;
					tabsToMove.forEach(function(aTab) { gBrowser.moveTabTo(aTab, endPos); });
				}
			}
			// failed to load so clear autosession in case user tried to load one
			else gSessionManager.setPref("_autosave_name", "");
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
				state[4] = state[4].replace(/_sm_window_session_name:\"[^\s]*\"/, '_sm_window_session_name:\"' + escape(values.text) + '\"');
				state[4] = this.decryptEncryptByPreference(state[4]); 
				state = state.join("\n");
			}
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
				this.setPref("_autosave_name", values.text);
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

	toggleResume: function()
	{
		this.setResumeCurrent(!this.doResumeCurrent());
	},

	toggleReload: function()
	{
		this.setPref("reload", !this.mPref_reload);
	},

	toggleOverwrite: function()
	{
		this.setPref("overwrite", !this.mPref_overwrite);
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
		closedTabs = eval(closedTabs);
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
			menuitem.setAttribute("onclick", 'gSessionManager.clickClosedUndoMenuItem(event);');
			menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
			aPopup.insertBefore(menuitem, listEnd);
		});
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
			
			var okay = this.restoreSession((aMode == "overwrite" || aMode == "append")?window:null, state, aMode != "append", false);
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
				var closedTabs = eval("(" + this.mSessionStore().getClosedTabData(window) + ")");
				// Work around for bug 350558 which sometimes mangles the _closedTabs.state.entries array data
				if (this.mAppVersion < "1.9") this.fixBug350558(closedTabs);
				// purge closed tab at aIndex
				closedTabs.splice(aIx, 1);
				state.windows[0]._closedTabs = closedTabs;
			}

			// replace existing _closedTabs
			this.mSessionStore().setWindowState(window, uneval(state), false);
			
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

	session_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		get_("replace").hidden = (this.getBrowserWindows().length == 1);
	},

	session_load: function(aReplace) {
		if (this.mAppVersion < "1.9") document.popupNode.parentNode.hidePopup();
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
		if (this.mAppVersion < "1.9") document.popupNode.parentNode.hidePopup();
		var session = document.popupNode.getAttribute("filename");
		if (aWindow) {
			this.saveWindow(this.mSessionCache[session].name, session);
		}
		else {
			this.save(this.mSessionCache[session].name, session);
		}
	},
	
	session_rename: function() {
		if (this.mAppVersion < "1.9") document.popupNode.parentNode.hidePopup();
		var session = document.popupNode.getAttribute("filename");
		this.rename(session);
	},
	
	session_remove: function() {
		var session = document.popupNode.getAttribute("filename");
		if (this.mPromptService.confirm(window, this.mTitle, this._string("delete_confirm"))) {
			if (this.mAppVersion < "1.9") document.popupNode.parentNode.hidePopup();
			this.remove(session);
		}
	},
	
	session_setStartup: function() {
		if (this.mAppVersion < "1.9") document.popupNode.parentNode.hidePopup();
		var session = document.popupNode.getAttribute("filename");
		this.setPref("resume_session", session);
		this.setPref("startup", 2);
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
		
		params.SetNumberStrings(7);
		params.SetString(1, aSessionLabel);
		params.SetString(2, aAcceptLabel);
		params.SetString(3, aValues.name || "");
		params.SetString(4, aTextLabel || "");
		params.SetString(5, aAcceptExistingLabel || "");
		params.SetString(6, aValues.text || "");
		params.SetInt(1, ((aValues.addCurrentSession)?1:0) | ((aValues.multiSelect)?2:0) | ((aValues.ignorable)?4:0) | 
						  ((aValues.autoSaveable)?8:0) | ((aValues.remove)?16:0) | ((aValues.allowNamedReplace)?256:0));
		
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,modal,resizable,dialog=yes", params, (this.mFullyLoaded)?window:null);
		
		aValues.name = params.GetString(3);
		aValues.text = params.GetString(6);
		aValues.ignore = (params.GetInt(1) && 4)?1:0;
		aValues.autoSave = (params.GetInt(1) && 8)?1:0;
		return !params.GetInt(0);
	},
	
	// the aOverride variable in an optional callback procedure that will be used to get the session list instead
	// of the default getSessions() function.  The function must return an array of sessions where a session is an
	// object containing:
	//		name 		- This is what is displayed in the session select window
	//		fileName	- This is what is returned when the object is selected
	//		windows		- Window count (optional - if omited won't display either window or tab count)
	//		tabs		- Tab count	(optional - if omited won't display either window or tab count)
	//		autosave	- Will cause item to be bold (optional)
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
		// Remove all saved sessions
		this.getSessionDir().remove(true);
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
	// headerOnly - only return header data, not the entire session file.  Speeds up grabbing of session names
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	//
	getSessions: function(headerOnly, filter)
	{
		var matchArray;
		var sessions = [];
		var latest = 0;
		var latest_backup = 0;
		var trueUpdate = false;
		
		var filesEnum = this.getSessionDir().directoryEntries.QueryInterface(this.mComponents.interfaces.nsISimpleEnumerator);
		while (filesEnum.hasMoreElements())
		{
			var file = filesEnum.getNext().QueryInterface(this.mComponents.interfaces.nsIFile);
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
				if (!backupItem && (latest < cached.timestamp)) 
				{
					sessions.latestTime = cached.timestamp;
					latest = cached.timestamp;
				}
				else if (backupItem && (latest_backup < cached.timestamp)) {
					sessions.latestBackUpTime = cached.timestamp;
					latest_backup = cached.timestamp;
				}
				sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp, autosave: cached.autosave, windows: cached.windows, tabs: cached.tabs, backup: backupItem });
				continue;
			}
			if (matchArray = this.mSessionRegExp.exec(this.readSessionFile(file, headerOnly)))
			{
				try {
					if (filter && !filter.test(matchArray[1])) continue;
				} catch(ex) { 
					dump ("Session Manager: Bad Regular Expression passed to getSessions, ignoring\n"); 
				}
				var timestamp = parseInt(matchArray[2]) || file.lastModifiedTime;
				if (!backupItem && (latest < timestamp)) 
				{
					sessions.latestTime = timestamp;
					latest = timestamp;
				}
				else if (backupItem && (latest_backup < timestamp)) {
					sessions.latestBackUpTime = timestamp;
					latest_backup = timestamp;
				}
				sessions.push({ fileName: fileName, name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], windows: matchArray[4], tabs: matchArray[5], backup: backupItem });
				this.mSessionCache[fileName] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem };
				this.mSessionCache.timestamp = timestamp;
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
		if (trueUpdate) this.mObserverService.notifyObservers(window, "sessionmanager-list-update", "");
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
		this.updateToolbarButton(aList.length + this.mSessionStore().getClosedTabCount(window)  > 0);
	},

	appendClosedWindow: function(aState)
	{
		if (this.mPref_max_closed_undo == 0 || Array.every(gBrowser.browsers, this.isCleanBrowser))
		{
			return;
		}
		
		var name = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:this._string("untitled_window"));
		var windows = this.getClosedWindows();
		
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
		// Handle sanitizing if sanitize on shutdown without prompting
		if ((this.getPref("privacy.sanitize.sanitizeOnShutdown", false, true)) &&
			(!this.getPref("privacy.sanitize.promptOnSanitize", true, true)) &&
			(this.getPref("privacy.item.extensions-sessionmanager", false, true)))
		{
			this.sanitize();
			this.setPref("_autosave_name","");
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
				this.backupCurrentSession();
			}
			else
			{
				this.keepOldBackups(false);
			}
			
			this.delFile(this.getSessionDir(this.mAutoSaveSessionName), true);
		}
		
		this.delPref("_encrypted");
		this.delPref("_running");
		this.mPref__running = false;
		
		// Cleanup left over files from Crash Recovery
		if (this.getPref("extensions.crashrecovery.resume_session_once", false, true))
		{	
			this.delFile(this.getProfileFile("crashrecovery.dat"), true);
			this.delFile(this.getProfileFile("crashrecovery.bak"), true);
			this.delPref("extensions.crashrecovery.resume_session_once", true);
		}
	},
	
	autoSaveCurrentSession: function()
	{
		try
		{
			var state = this.getSessionState(this._string("autosave_session"));
			this.writeFile(this.getSessionDir(this.mAutoSaveSessionName), state);
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
			state = this.getSessionState(this._string_backup_session || this._string("backup_session"));
			try {
				var aState = eval("(" + this.decrypt(state.split("\n")[4]) + ")");
				if (!((aState.windows.length > 1) || (aState.windows[0]._closedTabs.length > 0) || (aState.windows[0].tabs.length > 1) || 
		    		(aState.windows[0].tabs[0].entries.length > 1) || (aState.windows[0].tabs[0].entries[0].url != "about:blank"))) {
					backup = 0;
				}
			} catch(ex) { dump(ex); }
		}
		
		if (backup == 2)
		{
			var dontPrompt = { value: false };
			var flags = this.mPromptService.BUTTON_TITLE_SAVE * this.mPromptService.BUTTON_POS_0 + 
			            this.mPromptService.BUTTON_TITLE_DONT_SAVE * this.mPromptService.BUTTON_POS_1 +
			            this.mPromptService.BUTTON_TITLE_IS_STRING * this.mPromptService.BUTTON_POS_2; 
			var results = this.mPromptService.confirmEx(null, this.mTitle, this._string_preserve_session || this._string("preserve_session"), flags,
			              null, null, this._string_save_and_restore || this._string("save_and_restore"),
			              this._string_prompt_not_again || this._string("prompt_not_again"), dontPrompt);
			backup = (results == 1)?-1:1;
			if (results == 2) this.setPref("restore_temporary", true);
			if (dontPrompt.value)
			{
				this.setPref("backup_session", (backup == -1)?0:1);
			}
		}
		if (backup > 0 || temp_backup)
		{
			this.keepOldBackups(backup > 0);
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
			state = uneval(this.decodeOldFormat(state, true));
			state = state.substring(1,state.length-1);
			var countString = getCountString(this.getCount(state));
			state = "[SessionManager]\nname=" + name + "\ntimestamp=" + timestamp + "\nautosave=false" + countString + state;
			this.writeFile(aFile, state);
		}
		// pre autosave and tab/window count
		else if ((/^\[SessionManager\]\nname=.*\ntimestamp=\d+\n/m.test(state)) &&
				 (!/^\[SessionManager\]\nname=.*\ntimestamp=\d+\nautosave=(false|session|window)\tcount=[1-9][0-9]*\/[1-9][0-9]*\n/m.test(state)))
		{
			// This should always match, but is required to get the RegExp values set correctly.
			// RegExp.$1 - Entire 4 line header
			// RegExp.$2 - Top 3 lines (includes name and timestamp)
			// RegExp.$3 - Autosave string (if it exists)
			// RegExp.$4 - Autosave value (not really used at the moment)
			// RegExp.$5 - Count string (if it exists)
			if (/((^\[SessionManager\]\nname=.*\ntimestamp=\d+\n)(autosave=(false|true|session|window)[\n]?)?(\tcount=[1-9][0-9]*\/[1-9][0-9]*\n)?)/m.test(state))
			{	
				var header = RegExp.$1;
				var nameTime = RegExp.$2;
				var auto = RegExp.$3;
				var autoValue = RegExp.$4;
				var count = RegExp.$5;
				var goodSession = true;
				
				// If two autosave lines, session file is bad so try and fix it (shouldn't happen anymore)
				if (/autosave=(false|true|session|window).*\nautosave=(false|true|session|window)/m.test(state)) {
					goodSession = false;
				}
				
				// read entire file if only read header
				if (headerOnly) state = this.readFile(aFile);

				if (goodSession)
				{
					var data = state.split("\n")[((auto) ? 4 : 3)];
					var countString = (count) ? (count) : getCountString(this.getCount(data));
					var autoSaveString = (auto) ? (auto).split("\n")[0] : "autosave=false";
					if (autoSaveString == "autosave=true") autoSaveString = "autosave=session";
					state = nameTime + autoSaveString + countString + this.decryptEncryptByPreference(data)
					// bad session so rename it so it won't load again - This catches case where window and/or 
					// tab count is zero.  Technically we can load when tab count is 0, but that should never
					// happen so session is probably corrupted anyway so just flag it so.
					if (/(\d\/0)|(0\/\d)/.test(countString)) 
					{
						state = state.replace(/^\[SessionManager\]\n/,"[Bad-SessionManager]\n");
						var leafName = aFile.leafName;
						this.delFile(aFile, true);
						aFile = this.getSessionDir(aFile.leafName + ".bad");
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

/* ........ Encryption functions .............. */

	cryptError: function(aException)
	{
		var text;
		if (aException.message) {
			if (aException.message.indexOf("decryptString") != -1) {
				if (aException.message.indexOf("NS_ERROR_FAILURE") != -1) {
					text = this._string("decrypt_fail1");
				}
				else {
					text = this._string("decrypt_fail2");
				}
			}
			else {
				text = this._string_encrypt_fail || this._string("encrypt_fail");
			}
		}
		else text = aException;
		this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, text);
	},

	decrypt: function(aData)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		if (aData.indexOf(":") == -1)
		{
			try {
				aData = this.mSecretDecoderRing.decryptString(aData);
			}
			catch (ex) { 
				this.cryptError(ex); 
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
		var encryped = (aData.indexOf(":") == -1);
		try {
			if (this.mPref_encrypt_sessions && !encryped)
			{
				aData = this.mSecretDecoderRing.encryptString(aData);
			}
			else if (!this.mPref_encrypt_sessions && encryped)
			{
				aData = this.mSecretDecoderRing.decryptString(aData);
			}
		}
		catch (ex) { this.cryptError(ex); }
		return aData;
	},

	encryptionChange: function()
	{
		if (this.getPref("_encrypted","no") != this.mPref_encrypt_sessions) {
			this.setPref("_encrypted",this.mPref_encrypt_sessions);
			
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
				this.setPref("_encrypted",!this.mPref_encrypt_sessions);
				this.setPref("encrypt_sessions",!this.mPref_encrypt_sessions);
				this.cryptError(this._string("change_encryption_fail"));
			}
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
			aObj["_closedTabs"][aIndex] = eval(({ state : uneval(aValue[0]) }));
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
	},

	delPref: function(aName, aUseRootBranch)
	{
		((aUseRootBranch)?this.mPrefRoot:this.mPrefBranch).deleteBranch(aName);
	},

/* ........ Miscellaneous Enhancements .............. */

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
		                    ?(this.mSessionStartupValue._sessionType == Components.interfaces.nsISessionStartup.RESUME_SESSION)
		                    :this.getPref("browser.sessionstore.resume_session_once", false, true);
		var recoverOnly = this.mPref__running || sessionstart;
		var no_reload = this.getPref("_no_reload");
		if (no_reload) this.delPref("_no_reload");
		// handle crash where user chose a specific session
		if (recovering)
		{
			this.delPref("_recovering");
			this.delPref("_autosave_name");   // if user chooses another session, forget current session
			this.mPref__autosave_name = "";
			this.load(recovering, "startup");
		}
		else if (!recoverOnly && (this.mPref_restore_temporary || (this.mPref_startup == 1) || ((this.mPref_startup == 2) && this.mPref_resume_session)) && this.getSessions(true).length > 0)
		{
			var values = { ignorable: true };
			var session = (this.mPref_restore_temporary)?this.mBackupSessionName:((this.mPref_startup == 1)?this.selectSession(this._string("resume_session"), this._string("resume_session_ok"), values):this.mPref_resume_session);
			if (session && this.getSessionDir(session).exists())
			{
				this.load(session, "startup");
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
			// only reload if didn't recover from crash
			if (!no_reload) this._allowReload = true;
			setTimeout(function() {
				//dump("Recovery autosave_name: " + gSessionManager.mPref__autosave_name + "\n");
				gSessionManager.mSessionStore().setWindowValue(window,"_sm_autosave_name",escape(gSessionManager.mPref__autosave_name));
			}, 100);
		}
	},

	isCmdLineEmpty: function()
	{
		return (!window.arguments || window.arguments.length <= 1);
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
		// ignore option if not Firefox based because SeaMonkey won't be able to unhide the menu
		if (document.getElementById("menu_ToolsPopup")) {
			var sessionMenu = document.getElementById("sessionmanager-menu");
			if (sessionMenu) sessionMenu.hidden = this.mPref_hide_tools_menu;
		}
	},

/* ........ Auxiliary Functions .............. */
	// Undo closed tab function for SeaMonkey
	undoCloseTabSM: function (aIndex)
	{
		window.gSessionManager._allowReload = false;
		
		if (gSessionManager.mSessionStore().getClosedTabCount(window) == 0)	return;
		gSessionManager.mSessionStore().undoCloseTab(window, aIndex || 0);
	},

	// count windows and tabs
	getCount: function (aState)
	{
		var windows = 0, tabs = 0;
		
		try {
			aState = this.decrypt(aState);
		
			aState = eval("(" + aState + ")");
			aState.windows.forEach(function(aWindow) {
				windows = windows + 1;
				tabs = tabs + aWindow.tabs.length;
			});
		}
		catch (ex) {};

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

	getSessionState: function(aName, aOneWindow, aNoUndoData, aAutoSave)
	{
		var state = (aOneWindow)?this.mSessionStore().getWindowState(window):this.mSessionStore().getBrowserState();
		
		state = this.handleTabUndoData(state, aNoUndoData, true, (this.mAppVersion < "1.9"));
		var count = this.getCount(state);
		
		// encrypt state if encryption preference set
		state = this.decryptEncryptByPreference(state); 
		
		return (aName != null)?this.nameState(("[SessionManager]\nname=" + (new Date()).toString() + "\ntimestamp=" + Date.now() + 
				"\nautosave=" + ((aAutoSave)?("session"):"false") + "\tcount=" + count.windows + "/" + count.tabs + "\n" + state + "\n").replace(/\n\[/g, "\n$&"), aName || ""):state;
	},

	restoreSession: function(aWindow, aState, aReplaceTabs, aAllowReload, aStripClosedTabs, aEntireSession, aOneWindow)
	{
		// decrypt state if encrypted
		aState = this.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = this.openWindow(this.getPref("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				this.gSessionManager.restoreSession(this, aState, aReplaceTabs, aAllowReload, aStripClosedTabs);
				this.gSessionManager.__window_session_name = unescape(this.gSessionManager.mSessionStore().getWindowValue(aWindow,"_sm_window_session_name"));
				//dump("restore win " + this.gSessionManager.__window_session_name + "\n");
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		//Try and fix bug35058 even in FF 3.0, because session might have been saved under FF 2.0
		aState = this.handleTabUndoData(aState, aStripClosedTabs, false, true);  
		
		this._allowReload = aAllowReload;
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
		aState = eval("(" + aState + ")");
		if (aState.windows.length > 1)
		{
			// take off first window
			var firstWindow = aState.windows.shift();
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
		return uneval(aState);
	},
	
	handleTabUndoData: function(aState, aStrip, aSaving, afixBug350558)
	{
		aState = eval("(" + aState + ")");
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
		return uneval(aState);
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

	doResumeCurrent: function(aOnce)
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
	}
};

String.prototype.trim = function() {
	return this.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ");
};

window.addEventListener("load", gSessionManager.onLoad_proxy, false);
