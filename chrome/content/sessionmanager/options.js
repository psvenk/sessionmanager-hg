gSessionManager._onLoad = gSessionManager.onLoad;
gSessionManager.onLoad = function() {
	this._onLoad(true);
	
	var resume_session = _("resume_session");
	var sessions = this.getSessions(true);
	resume_session.appendItem(this._string("startup_resume"), this.mBackupSessionName, "");
	sessions.forEach(function(aSession) {
		if ((aSession.fileName != this.mAutoSaveSessionName) && (aSession.fileName != this.mBackupSessionName))
		{
			resume_session.appendItem(aSession.name, aSession.fileName, "");
		}
	}, this);
	// if no restore value, select previous browser session
	resume_session.value = _("extensions.sessionmanager.resume_session").value || this.mBackupSessionName;
	
	// hide option to hide toolbar menu if not Firefox since SeaMonkey can't unhide it
	if (!/(BonEcho|Minefield|Flock|Firefox|Netscape)/.test(navigator.userAgent))
		document.getElementById("hide_tools_menu").setAttribute("hidden", "true");
	
	// current load session no longer there
	if (resume_session.selectedIndex == -1) {
		resume_session.value ="";
		_("extensions.sessionmanager.resume_session").valueFromPreferences = resume_session.value;
		// change option to none if select session was selected
		if (_("startupOption").selectedIndex==2) {
			_("startupOption").selectedIndex = 0;
			_("extensions.sessionmanager.startup").valueFromPreferences = _("startupOption").selectedIndex;
		}
	}
	
	// Restore selected indexes and hide/show menus for startup options
	_("generalPrefsTab").selectedIndex = _("extensions.sessionmanager.options_selected_tab").valueFromPreferences;
	startupSelect(_("startupOption").selectedIndex = _("extensions.sessionmanager.startup").valueFromPreferences);
	
	// Hide mid-click preference if Tab Mix Plus or Tab Clicking Options is enabled
	var browser = this.mWindowMediator.getMostRecentWindow("navigator:browser");
	if (browser) {
		if ((typeof(browser.tabClicking) != "undefined") || (typeof(browser.TM_checkClick) != "undefined")) {
			_("midClickPref").style.visibility = "collapse";
		}
		
		if (browser.gSingleWindowMode) _("overwrite").label = gSessionManager._string("overwrite_tabs");
	}
};

gSessionManager.onUnload = function() {
	_("extensions.sessionmanager.options_selected_tab").valueFromPreferences = _("generalPrefsTab").selectedIndex;
};

var _disable = gSessionManager.setDisabled;

function readMaxClosedUndo()
{
	var value = _("extensions.sessionmanager.max_closed_undo").value;
	
	_disable(_("save_window_list"), value == 0);
	
	return value;
}

function readMaxTabsUndo()
{
	var value = _("browser.sessionstore.max_tabs_undo").value;
	
	_disable(_("save_closed_tabs"), value == 0);
	_disable(document.getElementsByAttribute("control", "save_closed_tabs")[0], value == 0);
	
	return value;
}

function promptClearUndoList()
{
	var max_tabs_undo = _("max_tabs").value;
	
	gSessionManager.clearUndoListPrompt();
	
	_("max_tabs").value = max_tabs_undo;
};

function readInterval()
{
	return _("browser.sessionstore.interval").value / 1000;
}

function writeInterval()
{
	return Math.round(parseFloat(_("interval").value) * 1000 || 0);
}

function readPrivacyLevel()
{
	var value = _("browser.sessionstore.privacy_level").value;
	
	_disable(_("postdata"), value > 1);
	_disable(document.getElementsByAttribute("control", "postdata")[0], value > 1);
	
	return value;
}

function _(aId)
{
	return document.getElementById(aId);
}

function selectSessionDir() {
	var nsIFilePicker = Components.interfaces.nsIFilePicker;
	var filepicker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);

	filepicker.init(window, gSessionManager._string("choose_dir"), nsIFilePicker.modeGetFolder);
	filepicker.appendFilters(nsIFilePicker.filterAll);
	var ret = filepicker.show();
	if (ret == nsIFilePicker.returnOK) {
		_("extensions.sessionmanager.sessions_dir").value = filepicker.file.path;
	}
} 	 

function defaultSessionDir() {
	_("extensions.sessionmanager.sessions_dir").value = '';
}

function checkEncryption(aState) {
	try {
		// force a master password prompt so we don't waste time if user cancels it
		gSessionManager.mSecretDecoderRing.encryptString("");
	}
	catch (ex) {
		gSessionManager.cryptError(gSessionManager._string("change_encryption_fail"));
		return !aState;
	}
	return aState;
}

function onLoad() {
	// For whatever reason, even though the height is calculated correction, the prefpane won't be sized correctly 
	// unless the description elements' style.height values are explicitly set so just set them to their current computed heights.
	var descriptions = document.getElementsByTagName('description'); 
	for (var i=0; i<descriptions.length; i++) {
		descriptions[i].style.height=document.defaultView.getComputedStyle(descriptions[i], null).getPropertyValue("height");
	}
	
	// Disable Apply Button by default
	document.getElementById("sessionmanagerOptions").getButton("extra1").disabled = true;
}

function startupSelect(index) {
	// hide/display corresponding menus	
	_("browserStartupPage").style.visibility = (index != 0)?"collapse":"visible";
	_("resume_session").style.visibility = (index != 2)?"collapse":"visible";
	if (index == 1) _("resume_session").style.visibility = "hidden";
}

function setStartValue() {
	_("extensions.sessionmanager.startup").valueFromPreferences = _("startupOption").selectedIndex;
}

function savePrefs() {
	var prefs = document.getElementsByTagName('preference');
	for (var i=0; i<prefs.length; i++) {
		prefs[i].valueFromPreferences = prefs[i].value;
	}
	setStartValue();
	
	// Disable Apply Button
	document.getElementById("sessionmanagerOptions").getButton("extra1").disabled = true;
}	

function enableApply() {
	document.getElementById("sessionmanagerOptions").getButton("extra1").disabled = false;
}