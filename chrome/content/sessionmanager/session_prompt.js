var gParams = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
var gSessionList = null;
var gTextBox = null;
var gAcceptButton = null;
var gSessionNames = {};
var gBannedNames = [];
var gExistingName = 0;
var gNeedSelection = false;

// GetInt bit values
// 1   = add current session - used when recovering from crash
// 2   = multiselect enable  - true if allowed to choose multiple sessions (used for deleting)
// 4   = ignorable           - Displays ignore checkbox
// 8   = autosaveable        - Displays autosave checkbox
// 16  = remove              - true if deleting session(s)
// 256 = allow name replace  - true if session cannot be overwritten (not currently used)

// GetString values
// 1 = Session Label         - Label at top of window
// 2 = Accept Label          - Okay Button label for normal accept
// 3 = Session Filename      - filename of session save file
// 4 = Text Label            - Label above text box
// 5 = Accept Existing Label - Okay button label when overwriting existing session
// 6 = Default Session Name  - Comes from page title

gSessionManager._onLoad = gSessionManager.onLoad;
gSessionManager.onLoad = function() {
	this._onLoad(true);
	
	_("mac_title").hidden = !/mac/i.test(navigator.platform);
	setDescription(_("session_label"), gParams.GetString(1));
	
	gAcceptButton = document.documentElement.getButton("accept");
	gAcceptButton.label = gParams.GetString(2) || gAcceptButton.label;
	
	var sessions = null;
	if (window.opener && window.opener.gSessionManager && window.opener.gSessionManager.getSessionsOverride) {
		if (typeof window.opener.gSessionManager.getSessionsOverride == "function") {
			try {
				sessions = window.opener.gSessionManager.getSessionsOverride();
			} catch (ex) { 
				dump ("Session Manager: Override function error\n" + ex + "\n");
			}
		}
		else dump ("Session Manager: Passed override function parameter is not a function\n");
		if (!sessions || !_isValidSessionList(sessions)) {
			gParams.SetInt(0, 1);
			window.close();
			return;
		}
	}
	else {
		sessions = this.getSessions(true);
	}
	
	if (gParams.GetInt(1) & 1) // add a "virtual" current session
	{
		sessions.unshift({ name: this._string("current_session"), fileName: "*" });
	}
	
	gSessionList = _("session_list");
	gSessionList.selType = (gParams.GetInt(1) & 2)?"multiple":"single";
	
	// Do not allow overwriting of open window or browser sessions
	gBannedNames = this.getWindowSessions();
	var currentSession = this.getPref("_autosave_name");
	if (currentSession) gBannedNames[currentSession.trim().toLowerCase()] = true;
	
	if (gParams.GetInt(1) & 4) // show the "Don't show [...] again" checkbox
	{
		_("checkbox_ignore").hidden = false;
	}

	if (gParams.GetInt(1) & 8) // show the Autosave checkbox
	{
		_("checkbox_autosave").hidden = false;
	}
	
	var sessionIndex = 1;
	sessions.forEach(function(aSession) {
		// Don't display current browser session or window sessions in list for delete or save
		if (!((gParams.GetInt(1) & 16) || (gParams.GetInt(1) & 8)) || !gBannedNames[aSession.name.trim().toLowerCase()])
		{
			var label;
			// add counts if not current browsing session since current session has no counts.
			if (aSession.fileName != "*" && aSession.windows && aSession.tabs) {
				label = aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")";
			}
			else label = aSession.name;
			var item = gSessionList.appendItem(label, aSession.fileName);
			item.setAttribute("autosave", aSession.autosave);
			item.setAttribute("session_loaded", gBannedNames[aSession.name.trim().toLowerCase()]);
			if (((sessions.latestName == aSession.name) && !(gParams.GetInt(1) & 1)) || (aSession.fileName == "*")) item.setAttribute("latest",true);
			if (aSession.fileName == gParams.GetString(3))
			{
				setTimeout(function(aItem) { gSessionList.selectItem(aItem); }, 0, item);
			}
			gSessionNames[aSession.name.trim().toLowerCase()] = sessionIndex;
			sessionIndex = sessionIndex + 1;
		}
	}, this);
	
	if (gParams.GetString(4)) // enable text box
	{
		_("text_container").hidden = false;
		setDescription(_("text_label"), gParams.GetString(4));
		gTextBox = _("text_box");
		
		onTextboxInput(gParams.GetString(6));
		if ((gBannedNames[gTextBox.value.trim().toLowerCase()] || gExistingName) && !(gParams.GetInt(1) & 256))
		{
			if (gExistingName) gParams.SetString(3, sessions[gExistingName - 1].fileName);
			gTextBox.value = "";
			onTextboxInput();
		}
	}

	if ((gNeedSelection = !gTextBox || !gParams.GetString(5)) || (gParams.GetInt(1) & 256)) // when no textbox or renaming
	{
		gSessionList.addEventListener("select", onListboxSelect, false);
		onListboxSelect();
	}
	
	// add accessibility shortcuts (single-click / double-click / return)
	for (var i = 0; i < gSessionList.childNodes.length; i++)
	{
		gSessionList.childNodes[i].setAttribute("ondblclick", "if (event.button == 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) gAcceptButton.doCommand();");
		if (gTextBox && !(gParams.GetInt(1) & 256))
		{
			gSessionList.childNodes[i].setAttribute("onclick", "if (event.button == 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onTextboxInput(gSessionList.childNodes[gSessionList.selectedIndex].label);");
		}
	}
	if (gTextBox)
	{
		gSessionList.setAttribute("onkeypress", "if (event.keyCode == event.DOM_VK_RETURN && this.selectedIndex > -1) { event.button = 0; eval(this.selectedItem.getAttribute('onclick')); event.preventDefault(); }");
	}
	
	if (gSessionList.hasAttribute("height"))
	{
		gSessionList.height = gSessionList.getAttribute("height");
	}
	if (!window.opener)
	{
		document.title += " - " + document.getElementById("bundle_brand").getString("brandFullName");
		document.documentElement.removeAttribute("screenX");
		document.documentElement.removeAttribute("screenY");
	}
	window.sizeToContent();
	
	gParams.SetInt(0, 1);
};

gSessionManager.onUnload = function() {
	function persist(aObj, aAttr, aValue)
	{
		aObj.setAttribute(aAttr, aValue);
		document.persist(aObj.id, aAttr);
	}
	
	if (window.opener)
	{
		persist(document.documentElement, "screenX", window.screenX - window.opener.screenX);
		persist(document.documentElement, "screenY", window.screenY - window.opener.screenY);
	}
	if (gSessionList) persist(gSessionList, "height", gSessionList.boxObject.height);
	
	gParams.SetInt(1, ((_("checkbox_ignore").checked)?4:0) | ((_("checkbox_autosave").checked)?8:0));
};

function onListboxSelect()
{
	if (!gTextBox)
	{
		gAcceptButton.disabled = gSessionList.selectedCount == 0;
	}
	else
	{
		onTextboxInput();
	}
}

function onTextboxInput(aNewValue)
{
	if (aNewValue)
	{
		var match = /   \([0-9]+\/[0-9]+\)$/m.exec(aNewValue);
		if (match)
		{
			aNewValue = aNewValue.substring(0,match.index);
		}
		gTextBox.value = aNewValue;
		setTimeout(function() { gTextBox.select(); gTextBox.focus(); }, 0);
	}
	
	var input = gTextBox.value.trim().toLowerCase();
	var oldWeight = !!gAcceptButton.style.fontWeight;
	
	gExistingName = gSessionNames[input] || 0;
	var newWeight = gExistingName || ((gParams.GetInt(1) & 256) && gSessionList.selectedCount > 0);
	
	_("checkbox_autosave").checked = (gExistingName && gSessionList.childNodes[gExistingName - 1])? (gSessionList.childNodes[gExistingName - 1].getAttribute("autosave") == "true") : false;
	
	if (!gNeedSelection && oldWeight != newWeight)
	{
		gAcceptButton.label = (newWeight)?gParams.GetString(5):gParams.GetString(2);
		gAcceptButton.style.fontWeight = (newWeight)?"bold":"";
	}
	gAcceptButton.disabled = !input || gBannedNames[input] || gNeedSelection && (gSessionList.selectedCount == 0 || gExistingName);
}

function onAcceptDialog()
{
	gParams.SetInt(0, 0);
	if (gNeedSelection || ((gParams.GetInt(1) & 256) && gSessionList.selectedCount > 0))
	{
		gParams.SetString(3, gSessionList.selectedItems.map(function(aItem) { return aItem.value || ""; }).join("\n"));
	}
	else if (gExistingName)
	{
		gParams.SetString(3, gSessionList.childNodes[gExistingName - 1].value);
	}
	else
	{
		gParams.SetString(3, "");
	}
	gParams.SetString(6, _("text_box").value.trim());
}

function setDescription(aObj, aValue)
{
	aValue.split("\n").forEach(function(aLine) {
		aObj.appendChild(document.createElement("description")).setAttribute("value", aLine);
	});
}

function _(aId)
{
	return document.getElementById(aId);
}

function _isValidSessionList(aSessions)
{
	if (aSessions==null || typeof(aSessions)!="object" || typeof(aSessions.length)!="number" || 
	    aSessions.length == 0 || !aSessions[0].name) {
		dump("Session Manager: Override function returned an invalid session list.\n");
		return false;
	}
	return true;
}