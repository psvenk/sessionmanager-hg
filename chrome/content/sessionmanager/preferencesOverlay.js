/*
  The following code originated from Tab Mix Plus - http://tmp.garyr.net/ 
  It will remove stored Session Manager saved files, when user selects to clear private data
  
  Michael Kraft modified gSessionManager_preferencesOverlay to make it work in Firefox 3.0,
  gSessionManager.addMenuItem to work in Firefox 3.1, and all functions (except 
  gSessionManager.tryToSanitize) to work in SeaMonkey 2.0.
*/

var gSessionManager_preferencesOverlay = {
	init: function() {
        window.removeEventListener("load", gSessionManager_preferencesOverlay.init, false);
		// BrowserPreferences = Firefox, prefDialog = SeaMonkey
		var prefWindow = document.getElementById('BrowserPreferences') || document.getElementById('prefDialog');
		if (prefWindow)
		{
	    	gSessionManager_preferencesOverlay.onPaneLoad(prefWindow.lastSelected);

			// Firefox
			if (prefWindow == document.getElementById('BrowserPreferences')) {
				var command = prefWindow._selector.getAttribute("oncommand");
				prefWindow._selector.setAttribute("oncommand", (command ? (command + ";") : "") + "gSessionManager_preferencesOverlay.onPaneLoad(getElementsByAttribute('selected','true')[0].label);");
			}
			// SeaMonkey
			else {
				var prefsTree = document.getElementById('prefsTree');
				if (prefsTree) {
					var command = prefsTree.getAttribute("onselect");
					prefsTree.setAttribute("onselect", (command ? (command + ";") : "") + "gSessionManager_preferencesOverlay.onPaneLoad(this.contentView.getItemAtIndex(this.currentIndex).prefpane.id);");
				}
			}
	    }
	},

	onPaneLoad: function (aPaneID) {
		// panePrivacy   - Firefox when Privacy pane isn't selected when option window opens
		// Privacy       - Firefox when Privacy pane is selected when option window opens
		// security_pane - SeaMonkey 2.0
		if (aPaneID == "panePrivacy" || aPaneID == "Privacy" || aPaneID == "security_pane") this.onPanePrivacyLoad(aPaneID);
	},

/* ........ panePrivacy .............. */

	onPanePrivacyLoad: function (aPaneID)	{
    	window.setTimeout(function() {
    	    var clearNowBn = document.getElementById("clearDataNow");
    	    if (clearNowBn && clearNowBn.getAttribute("oncommand").indexOf("gSessionManager") == -1) { 
    	        clearNowBn.setAttribute("oncommand", "gSessionManager.tryToSanitize(); " + clearNowBn.getAttribute("oncommand"));
				// SeaMonkey needs to have Session Manager added directly to preferences window
				if (aPaneID == "security_pane") {
					gSessionManager.addMenuItem(aPaneID);
				}
	        }
	    }, 200);
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
		if ((appVersion >= "1.9.1") && (window.location == "chrome://browser/content/sanitize.xul")) {
			this.mSanitizePreference = "privacy.cpd.extensions-sessionmanager";
		}
		pref.setAttribute('id', this.mSanitizePreference);
		pref.setAttribute('name', this.mSanitizePreference);
		pref.setAttribute('type', 'bool');
		prefs.appendChild(pref);

		if (lastListbox) {
			var listitem = document.createElement('listitem');
			listitem.setAttribute('label', this.sanitizeLabel.label);
			listitem.setAttribute('type', 'checkbox');
			listitem.setAttribute('accesskey', this.sanitizeLabel.accesskey);
			listitem.setAttribute('preference', this.mSanitizePreference);
			lastListbox.parentNode.appendChild(listitem);
		}
		else if (lastCheckbox) {
			var check = document.createElement('checkbox');
			check.setAttribute('label', this.sanitizeLabel.label);
			check.setAttribute('accesskey', this.sanitizeLabel.accesskey);
			check.setAttribute('preference', this.mSanitizePreference);
			lastCheckbox.parentNode.appendChild(check);
		}

		// Firefox only
		if (typeof(gSanitizePromptDialog) == 'object')
		{
			if (appVersion < "1.9.1") pref.setAttribute('readonly', 'true');
			check.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
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

window.addEventListener("load", gSessionManager_preferencesOverlay.init, false);
