var gSessionManager_preferencesOverlay = {
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
		var stringBundle = Components.classes["@mozilla.org/intl/stringbundle;1"]
		                   .getService(Components.interfaces.nsIStringBundleService)
		                   .createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		
		// Firefox = browserStartupPage, SeaMonkey = startupPage
		var startMenu = document.getElementById("browserStartupPage") || document.getElementById("startupPage");
		var height = 0;
		if (startMenu) {
			var menuitem = startMenu.appendItem(stringBundle.GetStringFromName("startup_load"), gSessionManager.STARTUP_LOAD());
			height = height + parseInt(window.getComputedStyle(menuitem, null).height);
			if (startMenu.value == gSessionManager.STARTUP_LOAD()) startMenu.selectedItem = menuitem;
			menuitem = startMenu.appendItem(stringBundle.GetStringFromName("startup_prompt"), gSessionManager.STARTUP_PROMPT());
			height = height + parseInt(window.getComputedStyle(menuitem, null).height);
			if (startMenu.value == gSessionManager.STARTUP_PROMPT()) startMenu.selectedItem = menuitem;
		}
		
		// SeaMonkey needs window size to be fixed since the radio buttons take up space
		if (document.getElementById("startupPage")) {
			if (!isNaN(height)) window.innerHeight = window.innerHeight + height;
		}
   },

/* ........ panePrivacy .............. */

	onPanePrivacyLoad: function (aPaneID)	{
   	    var clearNowBn = document.getElementById("clearDataNow");
   	    if (clearNowBn && clearNowBn.getAttribute("oncommand").indexOf("gSessionManager") == -1) { 
   	        clearNowBn.setAttribute("oncommand", "gSessionManager.tryToSanitize(); " + clearNowBn.getAttribute("oncommand"));
			// SeaMonkey needs to have Session Manager added directly to preferences window
			if (aPaneID == "security_pane") {
				gSessionManager.addMenuItem(aPaneID);
			}
        }
    }
}

// Attach sanitizing functions to gSessionManager
gSessionManager.onLoad = function() {
}

gSessionManager.onUnload = function() {
}

gSessionManager.addSanitizeItem = function () {
	window.removeEventListener('load', gSessionManager.addSanitizeItem, true);
	
	var sessionManagerItem = {
		clear : function() {
			try {
				gSessionManager.sanitize();
			} catch (ex) {
				try { Components.utils.reportError(ex); } catch(ex) {}
			}
		},
		get canClear() {
			return true;
		}
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
	}
		
	// don't leak
	sessionManagerItem = null;
}

gSessionManager.addMenuItem = function (aPaneID) {
	var isSeaMonkey = aPaneID == "security_pane";
	var doc = isSeaMonkey ? document.getElementById(aPaneID) : document;
	var prefs = doc.getElementsByTagName('preferences')[0];
	var checkboxes = doc.getElementsByTagName('checkbox')
	var listboxes = doc.getElementsByTagName('listitem');
	var lastCheckbox = (checkboxes.length) ? checkboxes[checkboxes.length -1] : null;
	var lastListbox = (listboxes.length) ? listboxes[listboxes.length -1] : null;
	if (prefs && (lastCheckbox || lastListbox)) // if this isn't true we are lost :)
	{

		// Determine Mozilla version to see what is supported
		var appVersion = "0";
		try {
			appVersion = Components.classes["@mozilla.org/xre/app-info;1"].
			             getService(Components.interfaces.nsIXULAppInfo).platformVersion;
		} catch (e) { dump(e + "\n"); }
		
		var pref = document.createElement('preference');
		// Firefox 3.5 and above only
		if (!isSeaMonkey && this.mApp.compareVersion("1.9.1a1pre") >= 0) {
			if (window.location == "chrome://browser/content/sanitize.xul") {
				this.mSanitizePreference = "privacy.cpd.extensions-sessionmanager";
			}
			else {
				this.mSanitizePreference = "privacy.clearOnShutdown.extensions-sessionmanager";
			}
		}
		pref.setAttribute('id', this.mSanitizePreference);
		pref.setAttribute('name', this.mSanitizePreference);
		pref.setAttribute('type', 'bool');
		prefs.appendChild(pref);

		if (lastListbox) {
			var listitem = document.createElement('listitem');
			listitem.setAttribute('label', this.sanitizeLabel.label);
			listitem.setAttribute('id', "sessionmanager_listbox");
			listitem.setAttribute('type', 'checkbox');
			listitem.setAttribute('accesskey', this.sanitizeLabel.accesskey);
			listitem.setAttribute('preference', this.mSanitizePreference);
			listitem.setAttribute('oncommand', "gSessionManager.confirm(this)");
			if (typeof(gSanitizePromptDialog) == 'object') {
				listitem.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
			}
			lastListbox.parentNode.appendChild(listitem);
		}
		else if (lastCheckbox) {
			var check = document.createElement('checkbox');
			check.setAttribute('label', this.sanitizeLabel.label);
			check.setAttribute('accesskey', this.sanitizeLabel.accesskey);
			check.setAttribute('preference', this.mSanitizePreference);
			check.setAttribute('oncommand', "gSessionManager.confirm(this)");
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

		// Firefox 3 only
		if ((typeof(gSanitizePromptDialog) == 'object') && (this.mApp.compareVersion("1.9.1a1pre") < 0))
		{
			pref.setAttribute('readonly', 'true');
		}
		
		// SeaMonkey needs to sync preference when display pref window
		if (isSeaMonkey) pref.updateElements();
	}
}

gSessionManager.tryToSanitize = function () {
	var prefService = Components.classes["@mozilla.org/preferences-service;1"]
						.getService(Components.interfaces.nsIPrefBranch);
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
}

gSessionManager.confirm = function (aElem) {
	if (!aElem.checked) return;

	var stringBundle = Components.classes["@mozilla.org/intl/stringbundle;1"]
	                   .getService(Components.interfaces.nsIStringBundleService)
	                   .createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
					   
	var timeframe = document.getElementById("sanitizeDurationChoice");
	var txt = stringBundle.GetStringFromName("delete_all_confirm") +
	          (timeframe ? (" - " + timeframe.label) : "");
	
	var okay = this.mPromptService.confirmEx(null, stringBundle.GetStringFromName("sessionManager"), txt, 
	                                         this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1,
	                                         null, null, null, null, {});
	aElem.checked = !okay;
}

window.addEventListener("load", gSessionManager_preferencesOverlay.init, false);
