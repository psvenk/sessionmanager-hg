/*
  The following code originated from Tab Mix Plus - http://tmp.garyr.net/ 
  It will remove stored Session Manager saved files, when user selects to clear private data
  
  Michael Kraft modified gSessionManager_preferencesOverlay to make it work in Firefox 3.0
*/

var gSessionManager_preferencesOverlay = {
	init: function() {
		var prefWindow = document.getElementById('BrowserPreferences');
		if (prefWindow)
		{
            window.removeEventListener("load", gSessionManager_preferencesOverlay.init, false);
	    	gSessionManager_preferencesOverlay.onPaneLoad(prefWindow.lastSelected);

    		prefWindow._selector.setAttribute("oncommand", prefWindow._selector.getAttribute("oncommand") + ";gSessionManager_preferencesOverlay.onPaneLoad(getElementsByAttribute('selected','true')[0].label)");
	    }
	},

	onPaneLoad: function (aPaneID) {
		if (aPaneID == "panePrivacy" || aPaneID == "Privacy") this.onPanePrivacyLoad();
	},

/* ........ panePrivacy .............. */

	onPanePrivacyLoad: function ()	{
    	window.setTimeout(function() {
    	    var clearNowBn = document.getElementById("clearDataNow");
    	    if (clearNowBn && clearNowBn.getAttribute("oncommand").indexOf("gSessionManager") == -1) { 
    	        clearNowBn.setAttribute("oncommand", "gSessionManager.tryToSanitize(); " + clearNowBn.getAttribute("oncommand"));
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
	if (typeof Sanitizer != 'function')
		return;
	// Sanitizer will execute this
	Sanitizer.prototype.items['extensions-sessionmanager'] = {
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
}

gSessionManager.addMenuItem = function () {
	var prefs = document.getElementsByTagName('preferences')[0];
	var firstCheckbox = document.getElementsByTagName('checkbox')[0];
	if (prefs && firstCheckbox) // if this isn't true we are lost :)
	{
		var pref = document.createElement('preference');
		pref.setAttribute('id', 'privacy.item.extensions-sessionmanager');
		pref.setAttribute('name', 'privacy.item.extensions-sessionmanager');
		pref.setAttribute('type', 'bool');
		prefs.appendChild(pref);

		var check = document.createElement('checkbox');
		check.setAttribute('label', this.sanitizeLabel.label);
		check.setAttribute('accesskey', this.sanitizeLabel.accesskey);
		check.setAttribute('preference', 'privacy.item.extensions-sessionmanager');
		firstCheckbox.parentNode.insertBefore(check, firstCheckbox);

		if (typeof(gSanitizePromptDialog) == 'object')
		{
			pref.setAttribute('readonly', 'true');
			check.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
		}
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
