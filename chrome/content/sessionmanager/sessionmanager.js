// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={};

// import the session_manager.jsm into the namespace
Components.utils.import("resource://sessionmanager/modules/logger.jsm", com.morac.SessionManagerAddon);
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm", com.morac.SessionManagerAddon);

// use the namespace
with (com.morac.SessionManagerAddon) {
	com.morac.SessionManagerAddon.gSessionManagerWindowObject = {
		mFullyLoaded: false,
		
		// SessionManager Window ID
		__SessionManagerWindowId: null,
		
		// timers
		_win_timer : null,
		_clear_state_timer: null,

		// window state
		_backup_window_sesion_data: null,
		__window_session_filename: null,
		__window_session_name: null,
		__window_session_time: 0,
		__window_session_group: null,
		mClosingWindowState: null,
		mCleanBrowser: null,
		mClosedWindowName: null,

/* ........ Observers .............. */

		// Listener for changes to tabs - See https://developer.mozilla.org/En/Listening_to_events_on_all_tabs
		// Only care about location and favicon changes
		// This is only registered when tab tree is visible in session prompt window while saving
		tabProgressListener: {
		
			findTabIndexForBrowser: function(aBrowser) {
				// Check each tab of this browser instance
				for (var index = 0; index < gBrowser.browsers.length; index++) {
					if (aBrowser == gBrowser.getBrowserAtIndex(index)) return index;
				}
				return null;
			},
			
			// Interface functions
			onLocationChange: function(aBrowser, webProgress, request, location) {
				var index = this.findTabIndexForBrowser(aBrowser);
				if (index != null) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", "locationChange " + index);
			},
			
			onLinkIconAvailable: function(aBrowser) {
				var index = this.findTabIndexForBrowser(aBrowser);
				if (index != null) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", "iconChange " + index + "  " + encodeURIComponent(aBrowser.contentDocument.title));
			},

			onProgressChange: function() {},
			onSecurityChange: function() {},
			onStateChange: function() {},
			onStatusChange: function() {},
			onRefreshAttempted: function() { return true; }
		},
		
		// Listener to detect load progress for browser.  Used to trigger cache bypass when loading sessions
		tabbrowserProgressListener: {
			QueryInterface: function(aIID)
			{
				if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
				    aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
				    aIID.equals(Components.interfaces.nsISupports))
					return this;
				throw Components.results.NS_NOINTERFACE;
			},

			onStateChange: function(aWebProgress, aRequest, aFlag, aStatus)
			{
				let wpl = Components.interfaces.nsIWebProgressListener;

				// If load starts, bypass cache.  If network stops removes listener (this should handle all cases
				// such as closing tab/window, stopping load or changing url).
				if (aFlag & wpl.STATE_START)
				{
					// Force load to bypass cache
					aRequest.loadFlags = aRequest.loadFlags | aRequest.LOAD_BYPASS_CACHE;
				}
				else if ((aFlag & wpl.STATE_STOP) && (aFlag & wpl.STATE_IS_NETWORK)) {
					// remove listener
					try {
						aWebProgress.chromeEventHandler.removeProgressListener(gSessionManagerWindowObject.tabbrowserProgressListener);
					} catch(ex) { logError(ex); }
				}
			},

			onLocationChange: function(aProgress, aRequest, aURI) { },
			onProgressChange: function(aWebProgress, aRequest, curSelf, maxSelf, curTot, maxTot) { },
			onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) { },
			onSecurityChange: function(aWebProgress, aRequest, aState) { }
		},

		observe: function(aSubject, aTopic, aData)
		{
			log("gSessionManagerWindowObject.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
			switch (aTopic)
			{
			case "sessionmanager:nsPref:changed":
				switch (aData)
				{
				case "click_restore_tab":
					this.watchForMiddleMouseClicks();
					break;
				case "hide_tools_menu":
				case "show_icon_in_menu":
					this.showHideToolsMenu();
					break;
				case "reload":
					if (gSessionManager.mPref["reload"]) {
						gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
					}
					else {
						gBrowser.tabContainer.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
					}
					break;
				case "max_closed_undo":
				case "use_SS_closed_window_list":
					this.updateUndoButton();
					break;
				case "do_not_color_toolbar_button":
					this.updateToolbarButton();
					break;
				case "session_name_in_titlebar":
				case "_autosave_values":
					gBrowser.updateTitlebar();
					this.updateToolbarButton();
					break;
				case "display_menus_in_submenu":
					this.updateMenus();
					break;
				case "keys":
					this.setKeys();
					break;
				}
				break;
			case "sessionmanager:middle-click-update":
				this.watchForMiddleMouseClicks();
				break;
			case "sessionmanager:save-tab-tree-change":
				// In Firefox 3.6 and above, the "load" event won't fire for cached pages where the favicon doesn't change. For example going back and forth on Google's site pages.
				// Using addTabsProgressListener instead of "load" works in this case.  It doesn't return the tab, but we can easily get it by
				// searching all tabs to find the one that contains the event's target (getBrowserForTab()).  
				// Since this is slower, than the "load" method only do it if save window's tab tree is visible.
				switch (aData) {
					case "open":
						gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
						gBrowser.addTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);
						// For Firefox 4.0 and higher need to listen for "tabviewhidden" event to handle tab group changes
						if ((Application.name == "Firefox") &&  (VERSION_COMPARE_SERVICE.compare(Application.version,"4.0b6") >= 0))
						  window.addEventListener("tabviewhidden", gSessionManagerWindowObject.onTabViewHidden, false);
						break;
					case "close":
						gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false);
						gBrowser.removeTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);
						// For Firefox 4.0 and higher need to listen for "tabviewhidden" event to handle tab group changes
						if ((Application.name == "Firefox") &&  (VERSION_COMPARE_SERVICE.compare(Application.version,"4.0b6") >= 0))
						  window.removeEventListener("tabviewhidden", gSessionManagerWindowObject.onTabViewHidden, false);
						break;
				}
				break;
			case "sessionmanager:close-windowsession":
				// if entering private browsing mode store a copy of the current window session name for use when exiting pbm
				let pb_window_session_data = null;
				if (gSessionManager.mAboutToEnterPrivateBrowsing && this.__window_session_filename) 
					pb_window_session_data = SessionStore.getWindowValue(window,"_sm_window_session_values");
					
				// notification will either specify specific window session name or be null for all window sessions
				if (this.__window_session_filename && (!aData || (this.__window_session_filename == aData))) {
					let abandon = aSubject.QueryInterface(Components.interfaces.nsISupportsPRBool).data;
					log((abandon ? "Abandoning" : "Closing") + " window session " + this.__window_session_filename);
					if (abandon) {
						gSessionManager.abandonSession(window);
					}
					else {
						gSessionManager.closeSession(window);
					}
				}
				
				// if entering private browsing mode store a copy of the current window session name in the window state for use when exiting pbm
				// Do this after we save the window
				if (gSessionManager.mAboutToEnterPrivateBrowsing) {
					SessionStore.setWindowValue(window, "_sm_pb_window_session_data", pb_window_session_data);
				}
				break;
			case "sessionmanager:initial-windows-restored":
				this.restoreWindowSession();
				break;
			case "sessionmanager:update-undo-button":
				// only update all windows if window state changed.
				if ((aData != "tab") || (window == aSubject)) this.updateUndoButton();
				break;
			case "sessionmanager:process-closed-window":
				// This will handle any left over processing that results from closing the last browser window, but
				// not actually exiting the browser and then opening a new browser window.  The window will be
				// autosaved or saved into the closed window list depending on if it was an autosave session or not.
				// The observers will then be removed which will result in the window being removed from memory.
				if (window != aSubject) {
					// Temporarily copy closing state to module
					gSessionManager.mClosingWindowState = this.mClosingWindowState;
					try { 
						if (!gSessionManager.closeSession(false)) this.onWindowClose();
					}
					catch(ex) { logError(ex); }
					gSessionManager.mClosingWindowState = null;
					this.mClosingWindowState = null;
					this.mCleanBrowser = null;
					this.mClosedWindowName = null;
					WIN_OBSERVING2.forEach(function(aTopic) {
						// This will throw an error if observers already removed so catch
						try {
							OBSERVER_SERVICE.removeObserver(this, aTopic);
						}
						catch(ex) {}
					}, this);
					log("observe: done processing closed window", "INFO");
				}
				break;
			case "sessionmanager:updatetitlebar":
				if (!aSubject || aSubject == window) {
					gBrowser.updateTitlebar();
					this.updateToolbarButton();
				}
				break;
			case "browser:purge-session-history":
				this.updateUndoButton(false);
				break;
			case "quit-application-granted":
				// Since we are quiting don't listen for any more notifications on last window
				WIN_OBSERVING2.forEach(function(aTopic) {
					// This will throw an error for if observers already removed so catch
					try {
						OBSERVER_SERVICE.removeObserver(this, aTopic);
					}
					catch(ex) {}
				}, this);
				
				// Copy window state to module
				gSessionManager.mClosingWindowState = this.mClosingWindowState;
				
				// Not doing the following because I want to keep the window session values in
				// backup sessions.  Currently the code won't restore window sessions unless the backup
				// session is loaded at startup anyway so it's okay that we don't clear out the values at shutdown.
/*				
				// If not restarting or if this window doesn't have a window session open, 
				// hurry and wipe out the window session value before Session Store stops allowing 
				// window values to be updated.
				if (!gSessionManager._restart_requested || !this.__window_session_filename) {
					log("observe: Clearing window session data", "INFO");
					// this throws if it doesn't exist so try/catch it
					try { 
						SessionStore.deleteWindowValue(window, "_sm_window_session_values");
					}
					catch(ex) {}
				}
*/					
				break;
			// timer periodic call
			case "timer-callback":
				if (aSubject == this._clear_state_timer) {
					log("Timer callback to clear closing window state data", "INFO");
					this.mClosingWindowState = null;
					this.mCleanBrowser = null;
					this.mClosedWindowName = null;
					this._clear_state_timer = null;
				}
				else {
					// save window session if open, but don't close it
					log("Timer callback for window timer", "EXTRA");
					gSessionManager.closeSession(window, false, true);
				}
				break;
			case "private-browsing":
				var button = document.getElementById("sessionmanager-toolbar");
				if (button) {
					if (aData == "enter") {
						button.setAttribute("private", "true"); 
						// abandon any open window sessions.  They will already have been saved by the Session Manager component
						gSessionManager.abandonSession(window, true);
					}
					else {
						button.removeAttribute("private"); 
						// delay because the SessionStore values are wrong at this point
						setTimeout(gSessionManagerWindowObject.restoreWindowSession, 0, true);
					}
				}
				break;
			}
		},
		

/* ........ Window Listeners .............. */
		
		// If the Session Manager module has initialized call onLoad otherwise hide the Session Manager menus.
		onLoad_proxy: function(aEvent) {
			this.removeEventListener("load", gSessionManagerWindowObject.onLoad_proxy, false);
			
			if (gSessionManager._initialized) {
				gSessionManagerWindowObject.updateMenus(true);
				gSessionManagerWindowObject.setKeys();
				gSessionManagerWindowObject.onLoad();
			}
			else {
				let sessionButton = document.getElementById("sessionmanager-toolbar");
				let undoButton = document.getElementById("sessionmanager-undo");
				let sessionMenu = document.getElementById("sessionmanager-menu");
				if (sessionButton) sessionButton.hidden = true;
				if (undoButton) undoButton.hidden = true;
				if (sessionMenu) sessionMenu.hidden = true;
			}
		},
		
		onLoad: function() {
			log("onLoad start, window = " + document.title, "TRACE");
			
			// Set the flag indicating that a browser window displayed
			gSessionManager._browserWindowDisplayed = true;

			// The close event fires when the window is either manually closed or when the window.close() function is called.  It does not fire on shutdown or when
			// windows close from loading sessions.  The unload event fires any time the window is closed, but fires too late to use SessionStore's setWindowValue.
			// We need to listen to both of them so that the window session window value can be cleared when the window is closed manually.
			// The window value is also cleared on a "quit-application-granted", but that doesn't fire when the last browser window is manually closed.
			window.addEventListener("close", this.onClose_proxy, false);		
			window.addEventListener("unload", this.onUnload_proxy, false);
			
			// Add an event listener to check if user finishes customizing the toolbar so we can tweak the button tooltips.
			// This only works in Gecko2 (Firefox 4+ and SeaMonkey 2.1+, but since it should be a one time thing, don't sweat it for older browsers
			window.addEventListener("aftercustomization", this.tweakToolbarTooltips, false);

			// Hook into older versions of Tab Mix Plus (0.3.8.4 and earlier) to handle session conversion 
			// Later versions (0.3.8.5 and up) call Session Manager directly to do conversions
			if (typeof(convertSession) == "object" && typeof(convertSession.doConvert) == "function") {
				convertSession.doConvert = this.doTMPConvert;
				convertSession.convertFile = this.doTMPConvertFile;
			}
		
			// Fix tooltips for toolbar buttons
			this.tweakToolbarTooltips();
			
			// If the shutdown on last window closed preference is not set, set it based on the O/S.
			// Enable for Macs, disable for everything else
			if (!gPreferenceManager.has("shutdown_on_last_window_close")) {
				if (/mac/i.test(navigator.platform)) {
					gPreferenceManager.set("shutdown_on_last_window_close", true);
				}
				else {
					gPreferenceManager.set("shutdown_on_last_window_close", false);
				}
			}
		
			// This will handle any left over processing that results from closing the last browser window, but
			// not actually exiting the browser and then opening a new browser window.  We do this before adding the observer
			// below because we don't want to run on the opening window, only on the closed window
			if (gSessionManager.getBrowserWindows().length == 1) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:process-closed-window", null);
				
			WIN_OBSERVING.forEach(function(aTopic) {
				OBSERVER_SERVICE.addObserver(this, aTopic, false);
			}, this);
			WIN_OBSERVING2.forEach(function(aTopic) {
				OBSERVER_SERVICE.addObserver(this, aTopic, false);
			}, this);
			gBrowser.tabContainer.addEventListener("TabClose", this.onTabOpenClose, false);
			gBrowser.tabContainer.addEventListener("TabOpen", this.onTabOpenClose, false)
			if (gSessionManager.mPref["reload"]) {
				gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
			}
			// If saving tab tree currently open, add event listeners
			if (gSessionManager.savingTabTreeVisible) {
				gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
				gBrowser.addTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);
				// For Firefox 4.0 and higher need to listen for "tabviewhidden" event to handle tab group changes
				if ((Application.name == "Firefox") &&  (VERSION_COMPARE_SERVICE.compare(Application.version,"4.0b6") >= 0))
					window.addEventListener("tabviewhidden", gSessionManagerWindowObject.onTabViewHidden, false);
			}
					
			// Hide Session Manager toolbar item if option requested
			this.showHideToolsMenu();
			
			// If in private browsing mode gray out session manager toolbar icon
			if (gSessionManager.isPrivateBrowserMode()) {
				var button = document.getElementById("sessionmanager-toolbar");
				if (button) button.setAttribute("private", "true"); 
			}
			
			// Undo close tab if middle click on tab bar - only do this if Tab Clicking Options
			// or Tab Mix Plus are not installed.
			this.watchForMiddleMouseClicks();

			// Handle restoring sessions do to crash, prompting, pre-chosen session, etc
			gSessionManager.recoverSession(window);
			this.updateUndoButton();
			
			// Tell Session Manager Helper Component that it's okay to restore the browser startup preference if it hasn't done so already
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:restore-startup-preference", null);
			
			// Update other browsers toolbars in case this was a restored window
			if (gSessionManager.mUseSSClosedWindowList) {
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
			
			if (!gSessionManager.isRunning())
			{
				// make sure that the _running storage value is running
				gSessionManager.setRunning(true);
			
				// If backup file is temporary, then delete it
				try {
					if (gPreferenceManager.get("backup_temporary", true)) {
						gPreferenceManager.set("backup_temporary", false)
						gSessionManager.delFile(gSessionManager.getSessionDir(BACKUP_SESSION_FILENAME));
					}
				} catch (ex) { logError(ex); }

				// If we did a temporary restore, set it to false			
				if (gSessionManager.mPref["restore_temporary"]) gPreferenceManager.set("restore_temporary", false)

				// Force saving the preferences
				OBSERVER_SERVICE.notifyObservers(null,"sessionmanager-preference-save",null);
			}
			
			// Watch for changes to the titlebar so we can add our sessionname after it since 
			// DOMTitleChanged doesn't fire every time the title changes in the titlebar.
			// If Firefox we can watch gBrowser.ownerDocument since that changes when the title changes, in SeaMonkey it doesn't change
			// and there's nothing else to watch so we need to do a hook.
			if (Application.name != "SeaMonkey") {
				gBrowser.ownerDocument.watch("title", gSessionManagerWindowObject.updateTitlebar);
			}
			else {
				this.hookSeaMonkeyUpdateTitlebar();
			}
			gBrowser.updateTitlebar();
			
			// update toolbar button if auto-save session is loaded and watch titlebar if it exists to see if we should update
			this.updateToolbarButton();

			// SeaMonkey doesn't have an undoCloseTab function so create one
			if (typeof(undoCloseTab) == "undefined") {
				undoCloseTab = function(aIndex) { gSessionManagerWindowObject.undoCloseTabSM(aIndex); }
			}
			
			// add call to gSessionManager_Sanitizer (code take from Tab Mix Plus)
			// nsBrowserGlue.js use loadSubScript to load Sanitizer so we need to add this here for the case
			// where the user disabled option to prompt before clearing data  (only used in SeaMonkey)
			let cmd = document.getElementById("Tools:Sanitize");
			if (cmd && (Application.name == "SeaMonkey")) 
				cmd.addEventListener("command", com.morac.SessionManagerAddon.gSessionManager.tryToSanitize, false);
			
			// Clear current window value setting if shouldn't be set.  Need try catch because first browser window will throw an exception.
			try {
				if (!this.__window_session_filename) {
					// Remove window session if not restoring from private browsing mode otherwise restore window session
					if (!SessionStore.getWindowValue(window, "_sm_pb_window_session_data")) {
						// Backup _sm_window_session_values first in case this is actually a restart or crash restore 
						if (!this._backup_window_sesion_data) this._backup_window_sesion_data = SessionStore.getWindowValue(window,"_sm_window_session_values");
						log("onLoad: Removed window session name from window: " + this._backup_window_sesion_data, "DATA");
						if (this._backup_window_sesion_data) gSessionManager.getAutoSaveValues(null, window);
					}
					else {
						this.restoreWindowSession(true);
					}
				}
			} catch(ex) {}
			
			// Put up one time message after upgrade if it needs to be displayed - only done for one window
			if (gSessionManager._displayUpdateMessage) {
				let url = gSessionManager._displayUpdateMessage;
				delete(gSessionManager._displayUpdateMessage);
				setTimeout(function() {
					gBrowser.selectedTab = gBrowser.addTab(url);
				},100);
			}
			
			// Keep track of opening windows on browser startup
			if (gSessionManager._countWindows) {
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:window-loaded", null);
			}

			// Store a window id for use when saving sessions.  Use the SessionStore __SSi value which exists for all
			// windows except the first window open.  For first window set it when SS
			if (window.__SSi) {
				this.__SessionManagerWindowId = window.__SSi;
				SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
			}
			
			// Update tab tree if it's open
			if (gSessionManager.savingTabTreeVisible) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", "windowOpen " + this.__SessionManagerWindowId);
			
			log("onLoad end", "TRACE");
		},

		// This fires only when the window is manually closed by using the "X" or via a window.close() call
		onClose_proxy: function()
		{
			log("onClose Fired", "INFO");
			gSessionManagerWindowObject.onWindowCloseRequest();
		},

		// This fires any time the window is closed.  It fires too late to use SessionStore's setWindowValue.
		onUnload_proxy: function(aEvent)
		{
			log("onUnload Fired", "INFO");
			this.removeEventListener("close", gSessionManagerWindowObject.onClose_proxy, false);
			this.removeEventListener("unload", gSessionManagerWindowObject.onUnload_proxy, false);
			this.removeEventListener("aftercustomization", gSessionManagerWindowObject.tweakToolbarTooltips, false);
			gSessionManagerWindowObject.onUnload();
		},

		onUnload: function()
		{
			log("onUnload start", "TRACE");
			let allWindows = gSessionManager.getBrowserWindows();
			let numWindows = allWindows.length;
			log("onUnload: numWindows = " + numWindows, "DATA");
			
			WIN_OBSERVING.forEach(function(aTopic) {
				OBSERVER_SERVICE.removeObserver(this, aTopic);
			}, this);

			// Remomving events that weren't added doesn't hurt anything so remove all possible events.
			gBrowser.tabContainer.removeEventListener("TabClose", this.onTabOpenClose, false);
			gBrowser.tabContainer.removeEventListener("TabOpen", this.onTabOpenClose, false);
			gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false)
			gBrowser.tabContainer.removeEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
			gBrowser.tabContainer.removeEventListener("click", this.onTabBarClick, false);
			// Only remove this event in Firefox 4 or higher
			if ((Application.name == "Firefox") &&  (VERSION_COMPARE_SERVICE.compare(Application.version,"4.0b6") >= 0))
			  window.removeEventListener("tabviewhidden", gSessionManagerWindowObject.onTabViewHidden, false);
			// Only remove this if the function exists (Firefox 3.5 and up)
			if (typeof gBrowser.removeTabsProgressListener == "function") {
				// SeaMonkey 2.1 throws an exception on this if not listening so catch it
				try {
					gBrowser.removeTabsProgressListener(this.tabProgressListener);
				} catch(ex) {}
			}

			// stop watching for titlebar changes
			gBrowser.ownerDocument.unwatch("title");
			
			// Last window closing will leaks briefly since mObserving2 observers are not removed from it 
			// until after shutdown is run, but since browser is closing anyway, who cares?
			if (numWindows != 0) {
				WIN_OBSERVING2.forEach(function(aTopic) {
					// This will throw an error for if observers already removed so catch
					try {
						OBSERVER_SERVICE.removeObserver(this, aTopic);
					}
					catch(ex) {}
				}, this);
			}
			
			// Remove event listener from sanitize command
			let cmd = document.getElementById("Tools:Sanitize");
			if (cmd && (Application.name == "SeaMonkey")) 
				cmd.removeEventListener("command", com.morac.SessionManagerAddon.gSessionManager.tryToSanitize, false);
			
			// Stop Session timer if last window closed
			if (gSessionManager._timer && (numWindows == 0)) { 
				log("onUnload: Session Timer stopped because last window closed", "INFO");
				gSessionManager._timer.cancel();
				gSessionManager._timer = null;
			}

			this.onWindowClose();
							
			// This executes whenever the last browser window is closed (either manually or via shutdown).
			if (gSessionManager.isRunning() && numWindows == 0)
			{
				gSessionManager._screen_width = screen.width;
				gSessionManager._screen_height = screen.height;
				
				gSessionManager.mTitle += " - " + document.getElementById("bundle_brand").getString("brandFullName");

				// This will run the shutdown processing if the preference is set and the last browser window is closed manually
				if (gSessionManager.mPref["shutdown_on_last_window_close"] && !gSessionManager._stopping) {
					WIN_OBSERVING2.forEach(function(aTopic) {
						// This will throw an error for if observers already removed so catch
						try {
							OBSERVER_SERVICE.removeObserver(this, aTopic);
						}
						catch(ex) {}
					}, this);
					// Copy window state to module so session data is available
					gSessionManager.mClosingWindowState = this.mClosingWindowState;
					this.mClosingWindowState = null;
					this.mCleanBrowser = null;
					this.mClosedWindowName = null;
					gSessionManager.shutDown();
					// Don't look at the session startup type if a new window is opened without shutting down the browser.
					gSessionManager.mAlreadyShutdown = true;
				}
			}
			
			// Update tab tree if it's open
			if (gSessionManager.savingTabTreeVisible) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", "windowClose " + this.__SessionManagerWindowId);
			
			log("onUnload end", "TRACE");
		},

		// This is needed because a window close can be cancelled and we don't want to process such as closing a window
		onWindowCloseRequest: function() {
			log("onWindowCloseRequest start", "TRACE");
			
			// Clear any previously closing state data so we get fresh data
			this.mClosingWindowState = null;
			this.mCleanBrowser = null;
			this.mClosedWindowName = null;
			
			try {
				// Store closing state if it will be needed later
				if (this.__window_session_filename || !gSessionManager.mUseSSClosedWindowList || (gSessionManager.getBrowserWindows().length == 1)) {
					log("onWindowCloseRequest saved closing state", "INFO");
					this.mClosingWindowState = gSessionManager.getSessionState(null, window, null, null, null, true); 
					// Only need to save closed window data is not using browser's closed window list
					if (!gSessionManager.mUseSSClosedWindowList) {
						this.mCleanBrowser = Array.every(gBrowser.browsers, gSessionManager.isCleanBrowser);
						this.mClosedWindowName = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:gSessionManager._string("untitled_window"));
					}
					
					// Set up a one second timer to clear the saved data in case the window isn't actually closing
					this._clear_state_timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
					this._clear_state_timer.init(gSessionManagerWindowObject, 1000, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
				}
			}
			catch(ex) { 
				logError(ex); 
			}
			log("onWindowCloseRequest end", "TRACE");
		},

		onWindowClose: function()
		{
			log("onWindowClose start", "TRACE");
			if (this._clear_state_timer) {
				log("Canceling clear closing window state timer", "INFO");
				this._clear_state_timer.cancel();
				this._clear_state_timer = null;
			}
			
			// if there is a window session save it (leave it open if browser is restarting)
			if (this.__window_session_filename) 
			{
				gSessionManager.closeSession(window, false, gSessionManager._restart_requested);
			}
				
			log("onWindowClose: running = " + gSessionManager.isRunning() + ", _stopping = " + gSessionManager._stopping, "DATA");
			
			let numWindows = gSessionManager.getBrowserWindows().length;
			log("onWindowClose: numWindows = " + numWindows, "DATA");
			
			// only save closed window if running and not shutting down 
			if (gSessionManager.isRunning() && !gSessionManager._stopping)
			{
				// save window in closed window list if not last window
				if (numWindows > 0)
				{
					if (!gSessionManager.mUseSSClosedWindowList) {
						let state = gSessionManager.getSessionState(null, window, null, null, null, true, null, this.mClosingWindowState);
						this.appendClosedWindow(state);
					}
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
				}
			}
			// Clear stored closing state if not the last window
			if (numWindows > 0) {
				this.mClosingWindowState = null; 
				this.mCleanBrowser = null;
				this.mClosedWindowName = null;
			}
			log("onWindowClose end", "TRACE");
		},
		
/* ........ Tab Listeners .............. */

		onTabViewHidden: function(aEvent)
		{
			OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type);
		},

		onTabOpenClose: function(aEvent)
		{
			gSessionManagerWindowObject.updateUndoButton();
			
			// Update tab tree when tab is opened or closed. For open
			if (gSessionManager.savingTabTreeVisible) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + gSessionManagerWindowObject.findTabIndex(aEvent.target));
		},
		
		// This is only registered when tab tree is visiable in session prompt window while saving
		onTabMove: function(aEvent)
		{
			OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + gSessionManagerWindowObject.findTabIndex(aEvent.target) + " " + aEvent.detail);
		},

		onTabRestoring_proxy: function(aEvent)
		{
			gSessionManagerWindowObject.onTabRestoring(aEvent);
		},
		
		// This will set up tabs that are loaded during a session load to bypass the cache
		onTabRestoring: function(aEvent)
		{
			// If tab reloading enabled and not offline
			if (gSessionManager.mPref["reload"] && !IO_SERVICE.offline) 
			{	
				// This is a load and not restoring a closed tab or window
				let tab_time = SessionStore.getTabValue(aEvent.originalTarget, "session_manager_allow_reload");
				
				if (tab_time) 
				{
					// Delete the tab value
					SessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_allow_reload");
					
					// Compare the times to make sure this really was loaded recently and wasn't a tab that was loading, but then closed and reopened later
					tab_time = parseInt(tab_time);
					tab_time = isNaN(tab_time) ? 0 : tab_time;
					let current_time = new Date();
					current_time = current_time.getTime();
					
					log("onTabRestoring: Tab age is " + ((current_time - tab_time)/1000) + " seconds.", "EXTRA");
					
					// Don't reload a tab older than the specified preference (defaults to 1 minute)
					if (current_time - tab_time < gSessionManager.mPref["reload_timeout"]) 
					{
						// List for load requests to set to ignore cache
						aEvent.originalTarget.linkedBrowser.addProgressListener(gSessionManagerWindowObject.tabbrowserProgressListener);
					}
				}
			}
		},
				
		onTabBarClick: function(aEvent)
		{
			//undo close tab on middle click on tab bar
			if (aEvent.button == 1 && aEvent.target.localName != "tab")
			{
				// If tab restored, prevent default since Firefox 4.0 opens a new tab in middle click
				if (undoCloseTab()) {
					aEvent.preventDefault();
					aEvent.stopPropagation();
				}
			}
		},

		// Undo close tab if middle click on tab bar if enabled by user - only do this if Tab Clicking Options
		// or Tab Mix Plus are not installed.
		watchForMiddleMouseClicks: function() 
		{
			var tabBar = gBrowser.tabContainer;
			if (gSessionManager.mPref["click_restore_tab"] && (typeof(tabClicking) == "undefined") && !gSessionManager.tabMixPlusEnabled) {
				tabBar.addEventListener("click", this.onTabBarClick, true);
			}
			else tabBar.removeEventListener("click", this.onTabBarClick, true);
		},

		onToolbarClick: function(aEvent, aButton)
		{
			if (aEvent.button == 1)
			{
				// simulate shift left clicking toolbar button when middle click is used
				let event = document.createEvent("XULCommandEvents");
				event.initCommandEvent("command", false, true, window, 0, false, false, true, false, null);
				aButton.dispatchEvent(event);
			}
			else if (aEvent.button == 2 && aButton.getAttribute("disabled") != "true")
			{
				aButton.open = true;
			}
		},
		
/* ........ Miscellaneous Enhancements .............. */

		// For Firefox, the tab index is stored in _tPos. For SeaMonkey use gBrowser.getTabIndex.  If that doesn't exist, do a search.
		findTabIndex: function(aTab) {
			if (typeof aTab._tPos != "undefined") return aTab._tPos
			else if (typeof gBrowser.getTabIndex == "function") return gBrowser.getTabIndex(aTab);
			else {
				// Check each tab of this browser instance
				for (var index = 0; index < aTab.parentNode.childNodes.length; index++) {
					if (aTab == aTab.parentNode.childNodes[index]) return index;
				}
				return null;
			}
		},

		appendClosedWindow: function(aState)
		{
			let cleanBrowser = (this.mCleanBrowser != null) ? this.mCleanBrowser : Array.every(gBrowser.browsers, gSessionManager.isCleanBrowser);
			if (gSessionManager.mPref["max_closed_undo"] == 0 || gSessionManager.isPrivateBrowserMode() || cleanBrowser)
			{
				return;
			}
			
			let name = this.mClosedWindowName || content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:gSessionManager._string("untitled_window"));
			let windows = gSessionManager.getClosedWindows_SM();
			
			// encrypt state if encryption preference set
			if (gSessionManager.mPref["encrypt_sessions"]) {
				aState = gSessionManager.decryptEncryptByPreference(aState);
				if (!aState) return;
			}
					
			aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
			windows.unshift({ name: name, state: aState });
			gSessionManager.storeClosedWindows_SM(windows.slice(0, gSessionManager.mPref["max_closed_undo"]));
		},

		checkWinTimer: function()
		{
			// only act if timer already started
			if ((this._win_timer && ((this.__window_session_time <=0) || !this.__window_session_filename))) {
				this._win_timer.cancel();
				this._win_timer = null;
				log("checkWinTimer: Window Timer stopped", "INFO");
			}
			else if ((this.__window_session_time > 0) && this.__window_session_filename) {
				if (this._win_timer)
					this._win_timer.cancel();
				else
					this._win_timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
				// Firefox bug 325418 causes PRECISE timers to not fire correctly when canceled and re-initialized so use SLACK instead - https://bugzilla.mozilla.org/show_bug.cgi?id=325418
				this._win_timer.init(gSessionManagerWindowObject, this.__window_session_time * 60000, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
				log("checkWinTimer: Window Timer started for " + this.__window_session_time + " minutes", "INFO");
			}
			
			// Since this is called when starting/stoping a window session use it to set the attribute
			// on the toolbar button which changes it's color.
			this.updateToolbarButton();
		},
		
		updateToolbarButton: function()
		{
			let windowTitleName = (gSessionManagerWindowObject.__window_session_name) ? (gSessionManager._string("window_session") + " " + gSessionManagerWindowObject.__window_session_name) : "";
			let sessionTitleName = (gSessionManager.mPref["_autosave_name"]) ? (gSessionManager._string("current_session2") + " " + gSessionManager.mPref["_autosave_name"]) : "";
			
			// Update toolbar button and tooltip
			let button = document.getElementById("sessionmanager-toolbar");
			// SeaMonkey keeps button in BrowserToolbarPalette which is in browser window.  The boxObject
			// only has a firstchild if the element is actually displayed so check that.
			if (button) {
			
				if (!gSessionManager.mPref["do_not_color_toolbar_button"]) {
					if (windowTitleName)
						button.setAttribute("windowsession", "true");
					else
						button.removeAttribute("windowsession");
						
					if (sessionTitleName)
						button.setAttribute("autosession", "true");
					else
						button.removeAttribute("autosession");
				} else {
						button.removeAttribute("windowsession");
						button.removeAttribute("autosession");
				}
			}
			
			// Titlebar only exists in Firefox 4 and higher
			let titlebar = document.getElementById("titlebar");
			if (titlebar) {
				let toolbar_title_label = document.getElementById("sessionmanager-titlebar-label");
				if (toolbar_title_label) {
					if (gSessionManager.mPref["session_name_in_titlebar"] == 0 || gSessionManager.mPref["session_name_in_titlebar"] == 1) {
						toolbar_title_label.value = windowTitleName + ((windowTitleName && sessionTitleName) ? ",   " : "") + sessionTitleName;
						toolbar_title_label.removeAttribute("hidden");
					}
					else 
						toolbar_title_label.setAttribute("hidden", "true");
				}
			}
		},
		
		tweakToolbarTooltips: function(aEvent) {
			let buttons = [document.getElementById("sessionmanager-toolbar"), document.getElementById("sessionmanager-undo")];
			for (let i=0; i < buttons.length; i++) {
				if (buttons[i] && buttons[i].boxObject && buttons[i].boxObject.firstChild) {
					buttons[i].boxObject.firstChild.setAttribute("tooltip",( i ? "sessionmanager-undo-button-tooltip" : "sessionmanager-button-tooltip"));
				}
			}
			
			// Update menus as well in case toolbar button was just added
			gSessionManagerWindowObject.updateMenus();
		},
		
		buttonTooltipShowing: function(aEvent, tooltip) {
			let windowTitleName = (gSessionManagerWindowObject.__window_session_name) ? (gSessionManager._string("window_session") + " " + gSessionManagerWindowObject.__window_session_name) : "";
			let sessionTitleName = (gSessionManager.mPref["_autosave_name"]) ? (gSessionManager._string("current_session2") + " " + gSessionManager.mPref["_autosave_name"]) : "";
		
			let value1 = sessionTitleName || windowTitleName;
			let value2 = sessionTitleName ? windowTitleName : "";

			if (value1) {
				tooltip.childNodes[1].value = value1;
				tooltip.childNodes[1].hidden = false;
				// Auto-session always on top.
				if (sessionTitleName) 
					tooltip.childNodes[1].setAttribute("autosession", "true");
				else 
					tooltip.childNodes[1].removeAttribute("autosession");
				if (value2) {
					tooltip.childNodes[2].value = value2;
					tooltip.childNodes[2].hidden = false;
				}
				else 
					tooltip.childNodes[2].hidden = true;
			}
			else {
				tooltip.childNodes[1].hidden = true;
				tooltip.childNodes[2].hidden = true;
			}
		},
		
		undoTooltipShowing: function(aEvent,tooltip) {
			let name = null;
			let url = null;
			if (SessionStore.getClosedTabCount(window)) {
				let closedTabs = SessionStore.getClosedTabData(window);
				closedTabs = gSessionManager.JSON_decode(closedTabs);
				name = closedTabs[0].title
				url = closedTabs[0].state.entries[closedTabs[0].state.entries.length - 1].url;
			}
			if (name) {
				tooltip.childNodes[1].value = name;
				tooltip.childNodes[1].hidden = false;
				
				if (url) {
					tooltip.childNodes[2].value = url;
					tooltip.childNodes[2].hidden = false;
					aEvent.view.XULBrowserWindow.setOverLink(url);
				}
				else 
					tooltip.childNodes[2].hidden = true;
			}
			else {
				tooltip.childNodes[1].hidden = true;
				tooltip.childNodes[2].hidden = true;
			}
		},
		
		updateUndoButton: function(aEnable)
		{
			let button = (document)?document.getElementById("sessionmanager-undo"):null;
			if (button)
			{
				let tabcount = 0;
				let wincount = 0;
				if (typeof(aEnable) != "boolean") {
					try {
						wincount = gSessionManager.mUseSSClosedWindowList ? SessionStore.getClosedWindowCount() : gSessionManager.getClosedWindowsCount();
						tabcount = SessionStore.getClosedTabCount(window);
					} catch (ex) { logError(ex); }
				}
				gSessionManager.setDisabled(button, (typeof(aEnable) == "boolean")?!aEnable:tabcount == 0 && wincount == 0);
			}
		},
		
		// Replace SeaMonkey's gBrowser.updateTitlebar function with our own which is used
		// to update the title bar with auto session names after SeaMonkey changes the title.
		hookSeaMonkeyUpdateTitlebar: function() {
			var _original = gBrowser.updateTitlebar; // Reference to the original function
			gBrowser.updateTitlebar = function() {
				// Execute before
				var rv = _original.apply(gBrowser, arguments);
				// execute afterwards
				try {
					var title = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
					                  .getInterface(Components.interfaces.nsIWebNavigation)
					                  .QueryInterface(Components.interfaces.nsIBaseWindow).title;
					title = gSessionManagerWindowObject.updateTitlebar("title", "", title)
					window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
					      .getInterface(Components.interfaces.nsIWebNavigation)
					      .QueryInterface(Components.interfaces.nsIBaseWindow).title = title;
				} catch (ex) {}

				// return the original result
				return rv;
			};
		},
		
		// Put current session name in browser titlebar
		// This is a watch function which is called any time the titlebar text changes
		// See https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Global_Objects/Object/watch
		updateTitlebar: function(id, oldVal, newVal)
		{
			if (id == "title") {
				// Don't kill browser if something goes wrong
				try {
					let windowTitleName = (gSessionManagerWindowObject.__window_session_name) ? (gSessionManager._string("window_session") + " " + gSessionManagerWindowObject.__window_session_name) : "";
					let sessionTitleName = (gSessionManager.mPref["_autosave_name"]) ? (gSessionManager._string("current_session2") + " " + gSessionManager.mPref["_autosave_name"]) : "";
					let title = ((windowTitleName || sessionTitleName) ? "(" : "") + windowTitleName + ((windowTitleName && sessionTitleName) ? ", " : "") + sessionTitleName + ((windowTitleName || sessionTitleName) ? ")" : "")
					
					if (title) {
						// Add window and browser session titles
						switch(gSessionManager.mPref["session_name_in_titlebar"]) {
							case 0:
								newVal = newVal + " - " + title;
								break;
							case 1:
								newVal = title + " - " + newVal;
								break;
						}
					}
				} 
				catch (ex) { 
					logError(ex); 
				}
			}
			return newVal;
		},

		updateMenus: function(aForceUpdateAppMenu)
		{
				function get_(a_parent, a_id) { return a_parent.getElementsByAttribute("_id", a_id)[0] || null; }					
		
				// Need to get menus and popups this way since once cloned they would have same id.
				var toolsmenu_popup = document.getElementById("sessionmanager-menu-popup");
				var toolsmenu_submenu = get_(toolsmenu_popup,"_sessionmanager-management-menu-popup");
				var toolsmenu_menu = get_(toolsmenu_popup,"sessionmanager-tools-menu");
				var toolsmenu_splitmenu = get_(toolsmenu_popup,"sessionmanager-tools-splitmenu");
				var toolsmenu_submenus_hidden = toolsmenu_splitmenu.hidden && toolsmenu_menu.hidden;
				
				var toolbar_popup = document.getElementById("sessionmanager-toolbar-popup");
				var toolbar_button_menu = toolbar_popup ? document.getElementById("sessionmanager-toolbar-menu") : null;
				var toolbar_button_splitmenu = toolbar_popup ? document.getElementById("sessionmanager-toolbar-splitmenu") : null;
				var toolbar_button_submenus_hidden = toolbar_popup ? (toolbar_button_splitmenu.hidden && toolbar_button_menu.hidden) : false;

				var update_app_menu = false || aForceUpdateAppMenu;

				// Display in submenu
				if (gSessionManager.mPref["display_menus_in_submenu"]) {
					// Find any added menu items not in submenu and remove them.  They will have the "_sm_menu_to_remove" attribute set to "true"
					var added_menuitems = toolsmenu_popup.getElementsByAttribute("_sm_menu_to_remove", "true");
					if (added_menuitems.length) {
						update_app_menu = true;
						while (added_menuitems.length) 
							toolsmenu_popup.removeChild(added_menuitems[0]);
					}
					if (toolbar_popup) {
						added_menuitems = toolbar_popup.getElementsByAttribute("_sm_menu_to_remove", "true");
						while (added_menuitems.length) 
							toolbar_popup.removeChild(added_menuitems[0]);
					}
				
					// Popup menu is under the normal menu item by default.  In Firefox 4 and up on Windows and Linux move it to the splitmenu
					if ((Application.name == "Firefox") &&  (VERSION_COMPARE_SERVICE.compare(Application.version,"4.0b6") >= 0) && (!/mac|darwin/i.test(navigator.platform))) {
						if (!toolsmenu_splitmenu.firstChild) {
							var menupopup = toolsmenu_menu.removeChild(toolsmenu_menu.menupopup);
							toolsmenu_splitmenu.appendChild(menupopup);
						}
						toolsmenu_splitmenu.hidden = false;
						toolsmenu_menu.hidden = true;
						if (toolbar_button_splitmenu) {
							if (!toolbar_button_splitmenu.firstChild) {
								var menupopup = toolbar_button_menu.removeChild(toolbar_button_menu.menupopup);
								toolbar_button_splitmenu.appendChild(menupopup);
							}
							toolbar_button_splitmenu.hidden = false;
							toolbar_button_menu.hidden = true;
						}
					}
					else {
						toolsmenu_menu.hidden = false;
						if (toolbar_button_menu) 
							toolbar_button_menu.hidden = false;
					}
				}
				else if (!toolsmenu_submenus_hidden || !toolbar_button_submenus_hidden) {
					// Clone the menu items into the Session Manager menu (quick and dirty, but it works)
					// Since the toolbar can be added and removed and it's state might not be known, check its state before re-adding menuitems.
					toolsmenu_menu.hidden = true;
					toolsmenu_splitmenu.hidden = true;
					var change_toolbar_button = (toolbar_button_menu && !toolbar_button_submenus_hidden);
					if (change_toolbar_button) {
						toolbar_button_menu.hidden = true;
						toolbar_button_splitmenu.hidden = true;
					}

					// Copy the menuitems from the tools menu popup.  Can do this for the button menu since it's the same as the tools menu
					for (var i=0; i<toolsmenu_submenu.childNodes.length; i++) {
						if (!toolsmenu_submenus_hidden) {
							var menuitem = toolsmenu_submenu.childNodes[i].cloneNode(true);
							menuitem.setAttribute("_sm_menu_to_remove", "true");
							toolsmenu_menu.parentNode.insertBefore(menuitem,toolsmenu_menu);
							update_app_menu = true;
						}
						if (change_toolbar_button) {
							var menuitem = toolsmenu_submenu.childNodes[i].cloneNode(true);
							menuitem.setAttribute("_sm_menu_to_remove", "true");
							toolbar_button_menu.parentNode.insertBefore(menuitem,toolbar_button_menu);
						}
					}
				}
				
				// There's a problem where sometimes switching menu styles causes toolbar button menupopup to no longer open
				// until any other menupopup (even in another window) is opened.  Calling the hidePopup() method seems to work around that.
				if (toolbar_popup) {
					toolbar_popup.hidePopup();
				}

				// clone popup menu for app menu menu
				if (document.getElementById("sessionmanager-appmenu") && update_app_menu) {
					var popup_menu = toolsmenu_popup.cloneNode(true);
					document.getElementById("sessionmanager-appmenu").replaceChild(popup_menu, document.getElementById("sessionmanager-appmenu-popup"));
					popup_menu.setAttribute("id", "sessionmanager-appmenu-popup");
				}
		},
		
		showHideToolsMenu: function()
		{
			// app menu is only in FF 4 and up
			for (var i=0; i<2; i++) {
				let sessionMenu = i ? document.getElementById("sessionmanager-appmenu") : document.getElementById("sessionmanager-menu");
				if (sessionMenu) {
					sessionMenu.hidden = gSessionManager.mPref["hide_tools_menu"];
					if (gSessionManager.mPref["show_icon_in_menu"])
						sessionMenu.setAttribute("icon", "true");
					else
						sessionMenu.removeAttribute("icon");
				}
			}
		},

		setKeys: function()
		{
			try {
				let keys = gPreferenceManager.get("keys", ""), keyname;
				keys = gSessionManager.JSON_decode(keys, true);

				if (!keys._JSON_decode_failed) {
					let keysets = document.getElementById("mainKeyset").getElementsByTagName("key");
					
					for (var i=0; i < keysets.length; i++) {
						if (keyname = keysets[i].id.match(/key_session_manager_(.*)/)) {
							if (keys[keyname[1]]) {
								keysets[i].setAttribute("key", keys[keyname[1]].key || keys[keyname[1]].keycode);
								keysets[i].setAttribute("modifiers", keys[keyname[1]].modifiers);
							}
							else {
								keysets[i].setAttribute("key", "");
								keysets[i].setAttribute("modifiers", "");
							}
						}
					}
				}
			} catch(ex) { logError(ex); }
		},
		
		restoreWindowSession: function(aPrivateBrowsingRestore)
		{
			let pb_window_session_data = SessionStore.getWindowValue(window,"_sm_pb_window_session_data");
			if (aPrivateBrowsingRestore && !pb_window_session_data)
				return;
		
			// check both the backup and current window value just in case
			let window_values = aPrivateBrowsingRestore ? pb_window_session_data : (gSessionManagerWindowObject._backup_window_sesion_data || SessionStore.getWindowValue(window,"_sm_window_session_values"));
			if (window_values) {
				// Check to see if window session still exists and if it does, read it autosave data from file in case it was modified after backup
				let values = window_values.split("\n");
				// build regular expression, escaping all special characters
				let escaped_name = values[0].replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
				let regexp = new RegExp("^" + escaped_name + "$");
				let sessions = gSessionManager.getSessions(regexp,null,true);
				// If filenames and session names match consider it a match
				if ((sessions.length == 1) && (sessions[0].fileName == values[0]) && (sessions[0].name == values[1])) {
					// If session is no longer an autosave session don't restore it.
					if (/^(window|session)\/?(\d*)$/.test(sessions[0].autosave)) {
						let time = parseInt(RegExp.$2);
						// use new group and time if they changed
						window_values = gSessionManager.mergeAutoSaveValues(sessions[0].fileName, sessions[0].name, sessions[0].group, time)
						gSessionManager.getAutoSaveValues(window_values, window);
					}
				}
			}
			log("restoreWindowSession: Restore new window after " + (aPrivateBrowsingRestore ? "exit private browsing" : "startup") + " done, window session = " + gSessionManagerWindowObject.__window_session_filename, "DATA");
			if (aPrivateBrowsingRestore && pb_window_session_data) 
				SessionStore.deleteWindowValue(window, "_sm_pb_window_session_data");
			else
				gSessionManagerWindowObject._backup_window_sesion_data = null;
				
			gSessionManagerWindowObject.updateUndoButton();

			// Update the __SessionManagerWindowId if it's not set (this should only be for the first browser window).
			if (!gSessionManagerWindowObject.__SessionManagerWindowId) {
				gSessionManagerWindowObject.__SessionManagerWindowId = window.__SSi;
				SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
			}
		},
		
/* ........ Auxiliary Functions .............. */

		// Over TMP's conversion functionality since it won't work any more, plus my method is more elegant
		doTMPConvert: function(aSession)
		{
			gSessionManagerWindowObject.doTMPConvertFile(null, true);
		},
		
		doTMPConvertFile: function(aFileUri, aSilent)
		{
			Components.utils.import("resource://sessionmanager/modules/session_convert.jsm", com.morac.SessionManagerAddon);
			gConvertTMPSession.init(true);
			if (!gConvertTMPSession.convertFile(aFileUri, aSilent) && !aSilent) {
				gConvertTMPSession._prompt.alert(null, gSessionManager._string("sessionManager"), gSessionManager._string("ss_none"));
			}
			gConvertTMPSession.cleanup();
		},
		
		// Undo closed tab function for SeaMonkey
		undoCloseTabSM: function(aIndex)
		{
			if (SessionStore.getClosedTabCount(window) == 0)	return;
			SessionStore.undoCloseTab(window, aIndex || 0);
			// Only need to check for empty close tab list if possibly re-opening last closed tabs
			if (!aIndex) this.updateUndoButton();
		},
	}
	
	window.addEventListener("load", gSessionManagerWindowObject.onLoad_proxy, false);
}

// For Tab Mix Plus until the author changes his code
if (!gSessionManager) var gSessionManager = {
	openOptions: function() {
		com.morac.SessionManagerAddon.gSessionManager.openOptions();
	}
}