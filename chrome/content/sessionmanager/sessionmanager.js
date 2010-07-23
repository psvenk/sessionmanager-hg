// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};

// import the session_manager.jsm into the namespace
Components.utils.import("resource://sessionmanager/modules/logger.jsm", com.morac);
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm", com.morac);

// use the namespace
with (com.morac) {
	com.morac.gSessionManagerWindowObject = {
		mFullyLoaded: false,
		
		// SessionManager Window ID
		__SessionManagerWindowId: null,
		
		// timers
		_win_timer : null,
		_clear_state_timer: null,

		// window state
		_backup_window_sesion_data: null,
		__window_session_name: null,
		mClosingWindowState: null,
		mCleanBrowser: null,
		mClosedWindowName: null,

/* ........ Observers .............. */

		// Listener for changes to tabs - See https://developer.mozilla.org/En/Listening_to_events_on_all_tabs
		// Only care about location and favicon changes
		// This is only registered when tab tree is visiable in session prompt window while saving
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
				if (index != null) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", "iconChange " + index);
			},

			onProgressChange: function() {},
			onSecurityChange: function() {},
			onStateChange: function() {},
			onStatusChange: function() {},
			onRefreshAttempted: function() { return true; }
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
					this.showHideToolsMenu();
					break;
				case "reload":
					if (gSessionManager.mPref_reload) {
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
				case "session_name_in_titlebar":
				case "_autosave_values":
					gBrowser.updateTitlebar();
					break;
				}
				break;
			case "sessionmanager:save-tab-tree-change":
				// In Firefox 3.0 and 3.5 the gBrowser.tabContainer "load" event always fires (multiple times) for any page load, even when reading cached pages.
				// In Firefox 3.6 and above, it won't fire for cached pages where the favicon doesn't change. For example going back and forth on Google's site pages.
				// Using addTabsProgressListener instead of "load" works in this case.  It doesn't return the tab, but we can easily get it by
				// searching all tabs to find the one that contains the event's target (getBrowserForTab()).  
				// Since this is slower, than the "load" method only do it if needed (Firefox 3.6 and above) and only do either if save window's tab tree is visible.
				switch (aData) {
					case "open":
						gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
						// For Firefox 3.5 and lower use tabbrowser "load" event otherwise use browser "addTabsProgressListener" notification
						if (VERSION_COMPARE_SERVICE.compare(gSessionManager.mPlatformVersion,"1.9.2a1pre") < 0) {
							gBrowser.tabContainer.addEventListener("load", gSessionManagerWindowObject.onTabLoad, true);
						}
						else {
							gBrowser.addTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);
						}
						break;
					case "close":
						gBrowser.tabContainer.removeEventListener("TabMove", this.onTabMove, false);
						if (VERSION_COMPARE_SERVICE.compare(gSessionManager.mPlatformVersion,"1.9.2a1pre") < 0) {
							gBrowser.tabContainer.removeEventListener("load", gSessionManagerWindowObject.onTabLoad, true);
						}
						else {
							gBrowser.removeTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);
						}
						break;
				}
				break;
			case "sessionmanager:close-windowsession":
				// notification will either specify specific window session name or be null for all window sessions
				if (this.__window_session_name && (!aData || (this.__window_session_name == aData))) {
					let abandon = aSubject.QueryInterface(Components.interfaces.nsISupportsPRBool).data;
					log((abandon ? "Abandoning" : "Closing") + " window session " + this.__window_session_name);
					if (abandon) {
						gSessionManager.abandonSession(window);
					}
					else {
						gSessionManager.closeSession(window);
					}
				}
				break;
			case "sessionmanager:initial-windows-restored":
				// check both the backup and current window value just in case
				let window_values = this._backup_window_sesion_data || SessionStore.getWindowValue(window,"_sm_window_session_values");
				if (window_values) gSessionManager.getAutoSaveValues(window_values, window);
				log("observe: Restore new window done, window session = " + this.__window_session_name, "DATA");
				this._backup_window_sesion_data = null;
				this.updateUndoButton();

				// Update the __SessionManagerWindowId if it's not set (this should only be for the first browser window).
				if (!this.__SessionManagerWindowId) {
					this.__SessionManagerWindowId = window.__SSi;
					SessionStore.setWindowValue(window, "__SessionManagerWindowId", window.__SSi);
				}
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
						// This will throw an error for if observers already removed so catch
						try {
							OBSERVER_SERVICE.removeObserver(this, aTopic);
						}
						catch(ex) {}
					}, this);
					log("observe: done processing closed window", "INFO");
				}
				break;
			case "sessionmanager:updatetitlebar":
				gBrowser.updateTitlebar();
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
				if (!gSessionManager._restart_requested || !this.__window_session_name) {
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
					if (aData == "enter") 
						button.setAttribute("private", "true"); 
					else 
						button.removeAttribute("private"); 
				}
				break;
			}
		},
		

/* ........ Window Listeners .............. */
		
		// If the Session Manager module has initialized call onLoad otherwise hide the Session Manager menus.
		onLoad_proxy: function(aEvent) {
			this.removeEventListener("load", gSessionManagerWindowObject.onLoad_proxy, false);
			
			if (gSessionManager._initialized) {
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
			
			// The close event fires when the window is either manually closed or when the window.close() function is called.  It does not fire on shutdown or when
			// windows close from loading sessions.  The unload event fires any time the window is closed, but fires too late to use SessionStore's setWindowValue.
			// We need to listen to both of them so that the window session window value can be cleared when the window is closed manually.
			// The window value is also cleared on a "quit-application-granted", but that doesn't fire when the last browser window is manually closed.
			window.addEventListener("close", this.onClose_proxy, false);		
			window.addEventListener("unload", this.onUnload_proxy, false);

			// Hook into Tab Mix Plus to handle session conversion
			if (typeof(convertSession) == "object" && typeof(convertSession.doConvert) == "function") {
				convertSession.doConvert = this.doTMPConvert;
				convertSession.convertFile = this.doTMPConvertFile;
			}
		
			// Fix tooltips for toolbar buttons
			let buttons = [document.getElementById("sessionmanager-toolbar"), document.getElementById("sessionmanager-undo")];
			for (let i=0; i < buttons.length; i++) {
				if (buttons[i] && buttons[i].boxObject && buttons[i].boxObject.firstChild)
					buttons[i].boxObject.firstChild.tooltipText = buttons[i].getAttribute("buttontooltiptext");
			}

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
			if (gSessionManager.mPref_reload) {
				gBrowser.tabContainer.addEventListener("SSTabRestoring", this.onTabRestoring_proxy, false);
			}
			// If saving tab tree currently open, add event listeners
			if (gSessionManager.savingTabTreeVisible) {
				gBrowser.tabContainer.addEventListener("TabMove", this.onTabMove, false);
				// For Firefox 3.5 and lower use tabbrowser "load" event otherwise use browser "addTabsProgressListener" notification
				if (VERSION_COMPARE_SERVICE.compare(gSessionManager.mPlatformVersion,"1.9.2a1pre") < 0) {
					gBrowser.tabContainer.addEventListener("load", gSessionManagerWindowObject.onTabLoad, true);
				}
				else {
					gBrowser.addTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);
				}
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
				if (gSessionManager.mPref_restore_temporary) gPreferenceManager.set("restore_temporary", false)

				// Force saving the preferences
				OBSERVER_SERVICE.notifyObservers(null,"sessionmanager-preference-save",null);
			}
			
			// Watch for changes to the titlebar so we can add our sessionname after it since 
			// DOMTitleChanged doesn't fire every time the title changes in the titlebar.
			// If Firefox we can watch gBrowser.ownerDocument since that changes when the title changes, in SeaMonkey it doesn't change
			// and there's nothing else to watch so we need to do a hook.
			if (Application.name != "SeaMonkey" ) {
				gBrowser.ownerDocument.watch("title", gSessionManagerWindowObject.updateTitlebar);
			}
			else {
				eval("gBrowser.updateTitlebar = " + gBrowser.updateTitlebar.toString().replace('window.QueryInterface(nsIInterfaceRequestor)', 'newTitle = gSessionManagerWindowObject.updateTitlebar("title", "", newTitle); $&'));
			}
			gBrowser.updateTitlebar();

			// Workaround for bug 366986
			// TabClose event fires too late to use SetTabValue to save the "image" attribute value and have it be saved by SessionStore
			// so make the image tag persistant so it can be read later from the xultab variable.
			SessionStore.persistTabAttribute("image");
			
			// SeaMonkey doesn't have an undoCloseTab function so create one
			if (typeof(undoCloseTab) == "undefined") {
				undoCloseTab = function(aIndex) { gSessionManagerWindowObject.undoCloseTabSM(aIndex); }
			}
			
			// add call to gSessionManager_Sanitizer (code take from Tab Mix Plus)
			// nsBrowserGlue.js use loadSubScript to load Sanitizer so we need to add this here for the case
			// where the user disabled option to prompt before clearing data 
			// This only executes for Firefox 3.0 and SeaMonkey 2.0.
			let cmd = document.getElementById("Tools:Sanitize");
			if (cmd) cmd.setAttribute("oncommand", "com.morac.gSessionManager.tryToSanitize();" + cmd.getAttribute("oncommand"));
			
			// Clear current window value setting if shouldn't be set.  Need try catch because first browser window will throw an exception.
			try {
				if (!this.__window_session_name) {
					// Backup _sm_window_session_values first in case this is actually a restart or crash restore 
					if (!this._backup_window_sesion_data) this._backup_window_sesion_data = SessionStore.getWindowValue(window,"_sm_window_session_values");
					log("onLoad: Removed window session name from window: " + this._backup_window_sesion_data, "DATA");
					if (this._backup_window_sesion_data) gSessionManager.getAutoSaveValues(null, window);
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
			gBrowser.tabContainer.removeEventListener("load", gSessionManagerWindowObject.onTabLoad, true);
			// Only remove this if the function exists (Firefox 3.5 and up)
			if (typeof gBrowser.removeTabsProgressListener == "function")
				gBrowser.removeTabsProgressListener(gSessionManagerWindowObject.tabProgressListener);

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
			
			// Stop Session timer and start another if needed
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
				if (gSessionManager.mPref_shutdown_on_last_window_close && !gSessionManager._stopping) {
					WIN_OBSERVING2.forEach(function(aTopic) {
						// This will throw an error for if observers already removed so catch
						try {
							OBSERVER_SERVICE.removeObserver(this, aTopic);
						}
						catch(ex) {}
					}, this);
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
				if (this.__window_session_name || !gSessionManager.mUseSSClosedWindowList || (gSessionManager.getBrowserWindows().length == 1)) {
					log("onWindowCloseRequest saved closing state", "INFO");
					this.mClosingWindowState = gSessionManager.getSessionState(null, window, null, null, null, true); 
					this.mCleanBrowser = Array.every(gBrowser.browsers, gSessionManager.isCleanBrowser);
					this.mClosedWindowName = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:gSessionManager._string("untitled_window"));
					
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
			if (this.__window_session_name) 
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

		onTabOpenClose: function(aEvent)
		{
			// Give browser a chance to update count closed tab count.  Only SeaMonkey currently needs this, but it doesn't hurt Firefox.
			setTimeout(gSessionManagerWindowObject.updateUndoButton, 0);
			
			// Update tab tree when tab is opened or closed. For open
			if (gSessionManager.savingTabTreeVisible) OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + gSessionManagerWindowObject.findTabIndex(aEvent.target));
		},
		
		// This is only registered when tab tree is visiable in session prompt window while saving
		onTabMove: function(aEvent)
		{
			OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + gSessionManagerWindowObject.findTabIndex(aEvent.target) + " " + aEvent.detail);
		},

		// This is only registered when tab tree is visiable in session prompt window while saving
		onTabLoad: function(aEvent) {
			// Update tab tree if it's open
			OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-tab-tree", aEvent.type + " " + gSessionManagerWindowObject.findTabIndex(aEvent.target) + " " + aEvent.target.image);
		},
		
		onTabRestoring_proxy: function(aEvent)
		{
			gSessionManagerWindowObject.onTabRestoring(aEvent);
		},
		
		// This is to try and prevent tabs that are closed during the restore preocess from actually reloading.  
		// It not 100% fool-proof, but it's better than nothing.
		onTabRestoring: function(aEvent)
		{
			// If tab reloading enabled and not offline
			if (gSessionManager.mPref_reload && !IO_SERVICE.offline) 
			{	
				// This is a load and not restoring a closed tab or window
				let tab_time = SessionStore.getTabValue(aEvent.originalTarget, "session_manager_allow_reload");
				let reload_delay = SessionStore.getTabValue(aEvent.originalTarget, "session_manager_delay_reload") ? 100 : 0;
				if (tab_time) 
				{
					// Delete the tab value
					SessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_allow_reload");
					if (reload_delay) SessionStore.deleteTabValue(aEvent.originalTarget, "session_manager_delay_reload");
					
					// Compare the times to make sure this really was loaded recently and wasn't a tab that was loading, but then closed and reopened later
					tab_time = parseInt(tab_time);
					tab_time = isNaN(tab_time) ? 0 : tab_time;
					let current_time = new Date();
					current_time = current_time.getTime();
					
					log("onTabRestoring: Tab age is " + ((current_time - tab_time)/1000) + " seconds.", "EXTRA");
					log("onTabRestoring: Reload delay is " + reload_delay, "EXTRA");
					
					// Don't reload a tab older than the specified preference (defaults to 1 minute)
					if (current_time - tab_time < gSessionManager.mPref_reload_timeout) 
					{
						// This originally came from Tab Mix Plus.  It reloads the tabs without having to wait for them to finishing loading.
						// The problem with this is that it will always load the last (most "forward") entry in a tab's history because the index hasn't
						// loaded yet so if this isn't the case, a delay is required.  So delay loading any tabs that have a forward history.
						function reload_tab(browser)  {
							const nsIWebNavigation = Components.interfaces.nsIWebNavigation;
							let _webNav = browser.webNavigation;
							try {
								let sh = _webNav.sessionHistory;
								if (sh)
									_webNav = sh.QueryInterface(nsIWebNavigation);
							} catch (e) { logError(e); }
			
							try {
								const flags = nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE;
								if (_webNav.canGoForward || !reload_delay) {
									_webNav.reload(flags);
								}
								else {
									log("onTabRestoring: History for " + _webNav.currentURI.spec + " not yet ready when reloading, trying again.", "EXTRA");
									// if we delayed, but there's no forward history then it hasn't loaded yet so try again.
									setTimeout( reload_tab, reload_delay, aEvent.originalTarget.linkedBrowser);
								}
							} catch (e) { logError(e); }
						}
						
						setTimeout( reload_tab, reload_delay, aEvent.originalTarget.linkedBrowser);
					}
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

		// Undo close tab if middle click on tab bar if enabled by user - only do this if Tab Clicking Options
		// or Tab Mix Plus are not installed.
		watchForMiddleMouseClicks: function() 
		{
			var tabBar = gBrowser.tabContainer;
			if (gSessionManager.mPref_click_restore_tab && (typeof(tabClicking) == "undefined") && (typeof(TM_checkClick) == "undefined")) {
				tabBar.addEventListener("click", this.onTabBarClick, false);
			}
			else tabBar.removeEventListener("click", this.onTabBarClick, false);
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
			if (gSessionManager.mPref_max_closed_undo == 0 || gSessionManager.isPrivateBrowserMode() || cleanBrowser)
			{
				return;
			}
			
			let name = this.mClosedWindowName || content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:gSessionManager._string("untitled_window"));
			let windows = gSessionManager.getClosedWindows_SM();
			
			// encrypt state if encryption preference set
			if (gSessionManager.mPref_encrypt_sessions) {
				aState = gSessionManager.decryptEncryptByPreference(aState);
				if (!aState) return;
			}
					
			aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
			windows.unshift({ name: name, state: aState });
			gSessionManager.storeClosedWindows_SM(windows.slice(0, gSessionManager.mPref_max_closed_undo));
		},

		checkWinTimer: function()
		{
			// only act if timer already started
			if ((this._win_timer && ((this.__window_session_time <=0) || !this.__window_session_name))) {
				this._win_timer.cancel();
				this._win_timer = null;
				log("checkWinTimer: Window Timer stopped", "INFO");
			}
			else if (!this._win_timer && (this.__window_session_time > 0) && this.__window_session_name) {
				this._win_timer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
				this._win_timer.init(gSessionManagerWindowObject, this.__window_session_time * 60000, Components.interfaces.nsITimer.TYPE_REPEATING_PRECISE);
				log("checkWinTimer: Window Timer started for " + this.__window_session_time + " minutes", "INFO");
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
		
		// Put current session name in browser titlebar
		// This is a watch function which is called any time the titlebar text changes
		// See https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Global_Objects/Object/watch
		updateTitlebar: function(id, oldVal, newVal)
		{
			if (id == "title") {
				// Don't kill browser if something goes wrong
				try {
					let windowTitleName = (gSessionManagerWindowObject.__window_session_name) ? (gSessionManager._string("window_session") + " " + gSessionManagerWindowObject.__window_session_name) : "";
					let sessionTitleName = (gSessionManager.mPref__autosave_name) ? (gSessionManager._string("current_session2") + " " + gSessionManager.mPref__autosave_name) : "";
					let title = ((windowTitleName || sessionTitleName) ? "(" : "") + windowTitleName + ((windowTitleName && sessionTitleName) ? ", " : "") + sessionTitleName + ((windowTitleName || sessionTitleName) ? ")" : "")
					
					if (title) {
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
				} 
				catch (ex) { 
					logError(ex); 
				}
			}
			return newVal;
		},
	
		showHideToolsMenu: function()
		{
			let sessionMenu = document.getElementById("sessionmanager-menu");
			if (sessionMenu) sessionMenu.hidden = gSessionManager.mPref_hide_tools_menu;
		},

/* ........ Auxiliary Functions .............. */

		// Over TMP's conversion functionality since it won't work any more, plus my method is more elegant
		doTMPConvert: function(aSession)
		{
			gSessionManagerWindowObject.doTMPConvertFile(null, true);
		},
		
		doTMPConvertFile: function(aFileUri, aSilent)
		{
			Components.classes["@mozilla.org/moz/jssubscript-loader;1"].getService(Components.interfaces.mozIJSSubScriptLoader).loadSubScript("chrome://sessionmanager/content/sessionconvert.js");
			delete(gSessionSaverConverter);
			gConvertTMPSession.init(true);
			if (!gConvertTMPSession.convertFile(aFileUri, aSilent) && !aSilent) {
				gConvertTMPSession._prompt.alert(null, gSessionManager._string("sessionManager"), gSessionManager._string("ss_none"));
			}
			gConvertTMPSession.cleanup();
			delete(gConvertTMPSession);
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
		com.morac.gSessionManager.openOptions();
	}
}