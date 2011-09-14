// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={};

// import into the namespace
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm", com.morac.SessionManagerAddon);
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm", com.morac.SessionManagerAddon);

// use the namespace
with (com.morac.SessionManagerAddon) {
	com.morac.SessionManagerAddon.gSessionManager_preferencesOverlay = {
		mSanitizePreference: "privacy.item.extensions-sessionmanager",

		init: function() {
			window.removeEventListener("load", arguments.callee, false);
			
			// BrowserPreferences = Firefox, prefDialog = SeaMonkey
			var prefWindow = document.getElementById('BrowserPreferences') || document.getElementById('prefDialog');
			if (prefWindow)
			{
				// Add event handlers for when panes load in Firefox
				var paneMain = document.getElementById('paneMain');
				if (paneMain) paneMain.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);

				var panePrivacy = document.getElementById('panePrivacy');
				if (panePrivacy) panePrivacy.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
				
				// Add event handlers for SeaMonkey
				var browserPane = document.getElementById('navigator_pane');
				if (browserPane) browserPane.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
				
				var securityPane = document.getElementById('security_pane');
				if (securityPane) securityPane.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
				
				// Handle case if pane is already loaded when option window opens.
				gSessionManager_preferencesOverlay.onPaneLoad(prefWindow.lastSelected);
			}
		},
		
		onPaneLoad_proxy: function (aEvent) {
			gSessionManager_preferencesOverlay.onPaneLoad(aEvent.target.id);
			//aEvent.target.removeEventListener("paneload", arguments.callee, false);
		},
		
		onPaneLoad: function (aPaneID) {
			var elem = document.getElementById(aPaneID);
			elem.removeEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
			switch (aPaneID) {
				case "paneMain":
				case "navigator_pane":
					this.onPaneMainLoad();
					break;
				case "panePrivacy":
				case "security_pane":
					this.onPanePrivacyLoad(aPaneID);
					break;
			}
		},

	/* ........ paneMain .............. */
		onPaneMainLoad: function (aPaneID) {
			// Firefox = browserStartupPage, SeaMonkey = startupPage
			var startMenu = document.getElementById("browserStartupPage") || document.getElementById("startupPage");
			var height = 0;
			if (startMenu) {
				var startup = gPreferenceManager.get("startup", 0);
				var menuitem = startMenu.appendItem(gSessionManager._string("startup_load"), STARTUP_LOAD);
				height = height + parseInt(window.getComputedStyle(menuitem, null).height);
				menuitem = startMenu.appendItem(gSessionManager._string("startup_prompt"), STARTUP_PROMPT);
				height = height + parseInt(window.getComputedStyle(menuitem, null).height);
				// Actually set preference so browser will pick up if user changes it
				if (startup) {
					// Save current value
					var currentValue = document.getElementById("browser.startup.page").valueFromPreferences;
				
					// Tell Session Manager Helper Component to ignore preference change below
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:ignore-preference-changes", "true");
					document.getElementById("browser.startup.page").valueFromPreferences = ((startup == 1) ? STARTUP_PROMPT : STARTUP_LOAD);
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:ignore-preference-changes", "false");
					
					// Listen for window closing in case user cancels without applying changes
					window.addEventListener("unload", function() {
						window.removeEventListener("unload", arguments.callee, false);
						
						if (document.getElementById("browser.startup.page").valueFromPreferences <= STARTUP_PROMPT) {
							//dump("restoring preference\n");
							// Tell Session Manager Helper Component to ignore preference change below
							OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:ignore-preference-changes", "true");
							document.getElementById("browser.startup.page").valueFromPreferences = currentValue;
							OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:ignore-preference-changes", "false");
						}
					}, false);		
				}
			}
			
			// SeaMonkey needs window size to be fixed since the radio buttons take up space
			if (document.getElementById("startupPage")) {
				if (!isNaN(height)) window.innerHeight = window.innerHeight + height;
			}
	   },

	/* ........ panePrivacy .............. */

		onPanePrivacyLoad: function (aPaneID)	{
			// The Clear Now button only exists in SeaMonkey
			var clearNowBn = document.getElementById("clearDataNow");
			if (clearNowBn) { 
				clearNowBn.addEventListener("command", com.morac.SessionManagerAddon.gSessionManager_preferencesOverlay.tryToSanitize, false);
				// SeaMonkey needs to have Session Manager added directly to preferences window
				if (aPaneID == "security_pane") {
					gSessionManager_preferencesOverlay.addMenuItem(aPaneID);
				}
			}
		},

	/* ....... Sanitizing funnctions ....... */
		addItems: function() {
			window.removeEventListener('load', gSessionManager_preferencesOverlay.addItems, true);

			gSessionManager_preferencesOverlay.addMenuItem();
			gSessionManager_preferencesOverlay.addSanitizeItem();
		},
	
		addSanitizeItem: function () {
			var sessionManagerItem = {
				clear : function() {
					try {
						gSessionManager.sanitize(this.range);
					} catch (ex) {
						try { Components.utils.reportError(ex); } catch(ex) {}
					}
				},
				get canClear() {
					return true;
				},
				willClear: false
			}
			
			// Firefox
			if (typeof Sanitizer == 'function') {
				// Sanitizer will execute this
				Sanitizer.prototype.items['extensions-sessionmanager'] = sessionManagerItem;
			}
			// SeaMonkey
			else if (typeof Sanitizer == 'object') {
				// Sanitizer will execute this
				Sanitizer.items['extensions-sessionmanager'] = sessionManagerItem;
			}

			// don't leak
			sessionManagerItem = null;
			
			// Try to fix window height now or do it later if listbox is collapsed;
			var itemList = document.getElementById("itemList");
			if (itemList) {
				if (itemList.collapsed) { 
					var detailsExpander = document.getElementById("detailsExpander");
					if (detailsExpander)
						detailsExpander.addEventListener("command", gSessionManager_preferencesOverlay.fixWindowHeight, true);
				}
				else
					this.fixWindowHeight();
			}
		},
		
		fixWindowHeight: function(aEvent) {
			if (aEvent) {
				var detailsExpander = document.getElementById("detailsExpander");
				if (detailsExpander)
					detailsExpander.removeEventListener("command", gSessionManager_preferencesOverlay.fixWindowHeight, true);
			}
			
			// fix window height so we can see our entry
			var smlb = document.getElementById("sessionmanager_listbox");
			if (smlb) {
				// Since other addons might insert their own check boxes above us, make sure we are visible.
				var index;
				for (var i=0; i<smlb.parentNode.children.length; i++) {
					if (smlb.parentNode.children[i] == smlb) {
						index = i + 1;
						break;
					}
				}
			
				var currentHeight = smlb.parentNode.boxObject.height;
				var boxHeight = smlb.parentNode.firstChild.boxObject.height;
			
				// Display our checkbox and any added above us if we aren't already displayed (in case other addons have the same idea)
				if (currentHeight < (boxHeight * index)) {
					smlb.parentNode.height = currentHeight + boxHeight * (index - 6);
				}
				
				window.sizeToContent();
			}
		},

		addMenuItem: function (aPaneID) {
			var isSeaMonkey = (Application.name.toUpperCase() == "SEAMONKEY");
			var doc = (isSeaMonkey && (typeof(aPaneID) != "undefined")) ? document.getElementById(aPaneID) : document;
			var prefs = doc.getElementsByTagName('preferences')[0];
			var checkboxes = doc.getElementsByTagName('checkbox')
			var listboxes = doc.getElementsByTagName('listitem');
			var lastCheckbox = (checkboxes.length) ? checkboxes[checkboxes.length -1] : null;
			var lastListbox = (listboxes.length) ? listboxes[listboxes.length -1] : null;
			if (lastCheckbox || lastListbox) 
			{
				var pref = null;
				// Firefox only since SeaMonkey does not have separate preferences for on demand and on shutdown sanitation.
				if (!isSeaMonkey) {
					if (window.location == "chrome://browser/content/sanitize.xul") {
						// Preference for "Clear Recent History" window (tools menu)
						this.mSanitizePreference = "privacy.cpd.extensions-sessionmanager";
						
						// Add listener to clear preference when window is closed
						window.addEventListener("unload", gSessionManager_preferencesOverlay.unload, false);
					}
					else {
						// Preference from "Settings for Clearing History" window (privacy options)
						this.mSanitizePreference = "privacy.clearOnShutdown.extensions-sessionmanager";
					}
				}

				// SeaMonkey Sanitize.xul window does not contain preferences
				if (prefs) {
					pref = document.createElement('preference');
					pref.setAttribute('id', this.mSanitizePreference);
					pref.setAttribute('name', this.mSanitizePreference);
					pref.setAttribute('type', 'bool');
					prefs.appendChild(pref);
				}
				
				if (lastListbox) {
					var listitem = document.createElement('listitem');
					listitem.setAttribute('label', this.sanitizeLabel.label);
					listitem.setAttribute('id', "sessionmanager_listbox");
					listitem.setAttribute('type', 'checkbox');
					listitem.setAttribute('accesskey', this.sanitizeLabel.accesskey);
					listitem.setAttribute('preference', this.mSanitizePreference);
					listitem.addEventListener("command", com.morac.SessionManagerAddon.gSessionManager_preferencesOverlay.confirm, true);
					if (typeof(gSanitizePromptDialog) == 'object') {
						listitem.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
					}
					lastListbox.parentNode.appendChild(listitem);
				}
				else if (lastCheckbox) {
					var check = document.createElement('checkbox');
					check.setAttribute('label', this.sanitizeLabel.label);
					check.setAttribute('name', "extensions-sessionmanager");  // For SeaMonkey
					check.setAttribute('id', "sessionmanager_checkbox");
					check.setAttribute('accesskey', this.sanitizeLabel.accesskey);
					check.setAttribute('preference', this.mSanitizePreference);
					check.addEventListener("command", com.morac.SessionManagerAddon.gSessionManager_preferencesOverlay.confirm, true);
					if (typeof(gSanitizePromptDialog) == 'object') {
						check.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
					}
				
					if (lastCheckbox.parentNode.localName == "row") {
						var newRow = document.createElement('row');
						newRow.appendChild(check);
						lastCheckbox.parentNode.parentNode.appendChild(newRow);
					}
					else {
						lastCheckbox.parentNode.appendChild(check);
					}
				}

				// If user is setting preference for clearing on shutdown (SeaMonkey only uses one preference so include it if preferences exist)  
				if (pref && (isSeaMonkey || this.mSanitizePreference == "privacy.clearOnShutdown.extensions-sessionmanager")) 
					pref.updateElements();
			}
		},

		// This function is only ever called in SeaMonkey
		tryToSanitize: function () {
			var prefService = Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefBranch);
			try {
				var promptOnSanitize = prefService.getBoolPref("privacy.sanitize.promptOnSanitize");
			} catch (e) { promptOnSanitize = true;}

			// if promptOnSanitize is true we call gSessionManager_Sanitizer.sanitize from Firefox Sanitizer
			if (promptOnSanitize)
				return false;

			try {
				var sanitizeSessionManager = prefService.getBoolPref("privacy.item.extensions-sessionmanager");
			} catch (e) { sanitizeSessionManager = false;}

			if (!sanitizeSessionManager)
				return false;

			gSessionManager.sanitize();
			return true;
		},

		confirm: function (aEvent) {
			if (!aEvent.target.checked) return;

			var timeframe = document.getElementById("sanitizeDurationChoice");
			var txt = gSessionManager._string("delete_all_confirm") + (timeframe ? (" - " + timeframe.label) : "");
		
			var okay = PROMPT_SERVICE.confirmEx(null, gSessionManager._string("sessionManager"), txt, 
												PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1,
												null, null, null, null, {});
			aEvent.target.checked = !okay;
		},
		
		unload: function() {
			window.removeEventListener("unload", gSessionManager_preferencesOverlay.unload, false);
			
			// Make it so the check box won't be checked the next time the user manually goes to clear 
			// recent history in Mozilla 1.9.1 and above
			gPreferenceManager.set("privacy.cpd.extensions-sessionmanager", false, true);
		}
	}

	window.addEventListener("load", gSessionManager_preferencesOverlay.init, false);
}