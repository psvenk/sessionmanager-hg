var gParams = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
var gSessionList = null;
var gTextBox = null;
var ggMenuList = null;
var gAcceptButton = null;
var gSessionNames = {};
var gGroupNames = [];
var gBackupGroupName = null;
var gBannedNames = [];
var gBackupNames = [];
// gExistingName is the index of the item with the name in the text field + 1.  Adding 1, makes it easier to check for
// an existing name since 0 means it does not match an existing name.  Just remember to subtract 1 before using.
var gExistingName = 0;
var gNeedSelection = false;

var sortedBy = 0;

// GetInt 1 bit values
// 1   = add current session - used when recovering from crash
// 2   = multiselect enable  - true if allowed to choose multiple sessions (used for deleting)
// 4   = ignorable           - Displays ignore checkbox
// 8   = autosaveable        - Displays autosave checkbox
// 16  = remove              - true if deleting session(s)
// 32  = grouping            - true if changing grouping
// 256 = allow name replace  - true if session cannot be overwritten (not currently used)

// GetString values
// 1 = Session Label         - Label at top of window
// 2 = Accept Label          - Okay Button label for normal accept
// 3 = Session Filename      - filename of session save file
// 4 = Text Label            - Label above text box
// 5 = Accept Existing Label - Okay button label when overwriting existing session
// 6 = Default Session Name  - Comes from page title
// 7 = Count String          - Count String for current crashed session

// SetInt 0 bit values
// 1 = Accept button pressed

// SetInt 1 bit values
// 4  = ignore               - ignore checkbox checked
// 8  = autosave             - autosave checkbox checked

// SetString values
// 3 = Session Filename
// 6 = Session Name
// 7 = Group Name

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
	
	// hide/show the "Don't show [...] again" checkbox
	_("checkbox_ignore").hidden = !(gParams.GetInt(1) & 4);

	// hide/show the Autosave checkbox
	_("checkbox_autosave").hidden = !(gParams.GetInt(1) & 8);
	
	gBackupGroupName = this._string("backup_sessions");
	gBackupNames[this._string("backup_session").trim().toLowerCase()] = true;
	gBackupNames[this._string("autosave_session").trim().toLowerCase()] = true;
	
	var deleting = (gParams.GetInt(1) & 16);
	var saving = (gParams.GetInt(1) & 8);
	var grouping = (gParams.GetInt(1) & 32);
	var groupCount = 0;
	sessions.forEach(function(aSession) {
		var trimName = aSession.name.trim().toLowerCase();
		// ban backup session names
		if (aSession.backup) gBackupNames[trimName] = true;
		// Don't display loaded sessions in list for delete or save or backup items in list for save or grouping
		if (!((aSession.backup && (saving || grouping)) || ((gBannedNames[trimName]) && (saving || deleting))))
		{
			// get window and tab counts for crashed session
			var windowCount = "?";
			var tabCount = "?";
			if (aSession.fileName == "*") {
				if (/(\d)\/(\d)/.test(gParams.GetString(7))) {
					windowCount = RegExp.$1;
					tabCount = RegExp.$2;
				}
			}
			else {
				windowCount = aSession.windows;
				tabCount = aSession.tabs;
			}
			// Build cells
			var nameCell = document.createElement("listcell");
			var groupCell = document.createElement("listcell");
			var wincountCell = document.createElement("listcell");
			var tabcountCell = document.createElement("listcell");
			nameCell.setAttribute("label", aSession.name);
			groupCell.setAttribute("label", aSession.group);
			// make backup group label gray
			groupCell.setAttribute("disabled", aSession.backup);
			wincountCell.setAttribute("label", windowCount);
			tabcountCell.setAttribute("label", tabCount);
			// format window and tab count text
			wincountCell.setAttribute("class", "number");
			tabcountCell.setAttribute("class", "number");
			var item = document.createElement("listitem");
			item.appendChild(nameCell);
			item.appendChild(groupCell);
			item.appendChild(wincountCell);
			item.appendChild(tabcountCell);
			item.label = aSession.name;
			item.value = aSession.fileName;
			if (aSession.group) item.setAttribute("group", aSession.group);
			item.setAttribute("autosave", aSession.autosave);
			item.setAttribute("session_loaded", gBannedNames[trimName] || null);
			if ((sessions.latestTime && (sessions.latestTime == aSession.timestamp) && !(gParams.GetInt(1) & 1)) || (aSession.fileName == "*")) item.setAttribute("latest",true);
			gSessionList.appendChild(item);
			// select passed in item if any
			if (aSession.fileName == gParams.GetString(3))
			{
				setTimeout(function(aItem) { gSessionList.selectItem(aItem); }, 0, item);
			}
			// Add session to name list
			gSessionNames[trimName] = gSessionList.getIndexOfItem(item) + 1;
			// Build group menu list
			if (aSession.group && !aSession.backup) {
				var regExp = new RegExp("^" + aSession.group + "|," + aSession.group + "$|," + aSession.group + ",");
				if (!regExp.test(gGroupNames.toString())) {
					gGroupNames[groupCount++] = aSession.group.trim();
				}
			}
		}
	}, this);
	
	if (gParams.GetString(4)) // enable text boxes
	{
		_("text_container").hidden = false;
		setDescription(_("text_label"), gParams.GetString(4));
		
		// If renaming and name already entered, disable the session selection list
		if (gParams.GetString(3) && !gParams.GetString(5)) gSessionList.disabled = true;

		// If group text input is enabled (saving & group changing)
		if ((gParams.GetInt(1) & 32) || gParams.GetString(5)) 
		{
			_("group-text-container").hidden = false;
			ggMenuList = _("group_menu_list");

			// Pre-populate Group Menu
			for (var i in gGroupNames) {
				ggMenuList.appendItem(gGroupNames[i]);
			}
		}
				
		// If session text input is enabled (saving & renaming)
		if (!(gParams.GetInt(1) & 32)) 
		{
			_("session-text-container").hidden = false;
			gTextBox = _("text_box");
		
			onTextboxInput(gParams.GetString(6));
			if ((gBannedNames[gTextBox.value.trim().toLowerCase()] || gExistingName) && !(gParams.GetInt(1) & 256))
			{
				if (gExistingName) gParams.SetString(3, sessions[gExistingName - 1].fileName);
				gTextBox.value = "";
				onTextboxInput();
			}
		}
	}

	if ((gNeedSelection = !gTextBox || !ggMenuList || !gParams.GetString(5)) || (gParams.GetInt(1) & 256)) // when no textbox or renaming
	{
		gSessionList.addEventListener("select", onListboxSelect, false);
		onListboxSelect();
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

function onListboxClick(aEvent)
{
	if ((aEvent.button == 0) && !aEvent.metaKey && !aEvent.ctrlKey && !aEvent.shiftKey && !aEvent.altKey) {
		if (aEvent.target.nodeName=="listitem") {
			switch (aEvent.type) {
				case "click":
					if (gTextBox && !(gParams.GetInt(1) & 256)) onTextboxInput(gSessionList.selectedItem.label);
					break;
				case "dblclick":
					gAcceptButton.doCommand();
					break;
			}
		}
		else if ((aEvent.type == "click") && (aEvent.target.nodeName == "listheader")) {
			var types = { name: 0, group: 1, win_count: 2, tab_count: 3 };
			var which = types[aEvent.target.id];
			
			// If not already sorted, sortedBy will be 0.  Otherwise it is which + 1 if inversely sorted or -(which + 1) if normally sorted
			var flag = (Math.abs(sortedBy) == (which + 1)) ? (-sortedBy / Math.abs(sortedBy)) : -1

			var items = [];
			while (gSessionList.getRowCount() > 0) items.push(gSessionList.removeItemAt(0));
			
			// Sort depending on which header is clicked
			if ((which == 0) || (which == 1)) {
				items = items.sort(function(a, b) { 
					return flag * (a.childNodes[which].getAttribute("label").toLowerCase().localeCompare(b.childNodes[which].getAttribute("label").toLowerCase())); 
				});
			}
			else if ((which == 2) || (which == 3)) {
				items = items.sort(function(a, b) { 
					return flag * (parseInt(a.childNodes[which].getAttribute("label")) - parseInt(b.childNodes[which].getAttribute("label"))); 
				});
			}
			
			while (items.length) {
				var item = items.pop();
				gSessionList.appendChild(item);	
				item.removeAttribute("current");
				var trimName = item.firstChild.getAttribute("label").trim().toLowerCase();
				gSessionNames[trimName] = gSessionList.getIndexOfItem(item) + 1;
			}
			sortedBy = flag * (which + 1);
		}
	}
}

function onListBoxKeyPress(aEvent)
{
	if (gTextBox && (aEvent.keyCode == aEvent.DOM_VK_RETURN) && (gSessionList.selectedIndex > -1)) {
		onTextboxInput(gSessionList.selectedItem.label);
		aEvent.preventDefault();
	}
}

function onListboxSelect()
{
	if (!gTextBox || !ggMenuList)
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
	
	var item;
	if (gExistingName && (item = gSessionList.getItemAtIndex(gExistingName - 1))) {
		_("checkbox_autosave").checked = item.getAttribute("autosave") != "false";
	}
	else _("checkbox_autosave").checked = false;
	
	if (!gNeedSelection && oldWeight != newWeight)
	{
		gAcceptButton.label = (newWeight && gParams.GetString(5))?gParams.GetString(5):gParams.GetString(2);
		gAcceptButton.style.fontWeight = (newWeight)?"bold":"";
	}

	// Highlight matching item when accept label changes to replace and copy in group value
	if (newWeight && gParams.GetString(5)) {
		// Things get screwy if you try to select an item being selected so don't do it.
		if (!aNewValue) gSessionList.selectedItem = item;
		if (ggMenuList) ggMenuList.value = item.getAttribute("group");
	}
		
	isAcceptable();
}

function isAcceptable() 
{
	var badSessionName = false;
	var badGroupName = false;
	
	if (ggMenuList) {
		var groupName = ggMenuList.value.trim();
		badGroupName = (groupName == gBackupGroupName)
		ggMenuList.inputField.setAttribute("badname", badGroupName);
	}
	
	if (gTextBox) {
		var input = gTextBox.value.trim().toLowerCase();
		gTextBox.setAttribute("badname", gBackupNames[input]);
		badSessionName = !input || gBackupNames[input] || gBannedNames[input];
	}
	
	gAcceptButton.disabled = badSessionName || badGroupName || (gNeedSelection && (gSessionList.selectedCount == 0 || gExistingName));
}

function onAcceptDialog()
{
	gParams.SetInt(0, 1);
	if (gNeedSelection || ((gParams.GetInt(1) & 256) && gSessionList.selectedCount > 0))
	{
		gParams.SetString(3, gSessionList.selectedItems.map(function(aItem) { return aItem.value || ""; }).join("\n"));
	}
	else if (gExistingName)
	{
		gParams.SetString(3, gSessionList.getItemAtIndex(gExistingName - 1).value);
	}
	else
	{
		gParams.SetString(3, "");
	}
	gParams.SetString(6, _("text_box").value.trim());
	gParams.SetString(7, _("group_menu_list").value.trim());
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