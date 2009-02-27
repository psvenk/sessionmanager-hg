var gParams = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
var gSessionTree = null;
var gTextBox = null;
var ggMenuList = null;
var gTabTree = null;
var gAcceptButton = null;
var gSessionNames = {};
var gGroupNames = [];
var gBackupGroupName = null;
var gBannedNames = [];
var gBackupNames = [];
var gSessionTreeData = [];
var gOriginalSessionTreeData;
// gExistingName is the index of the item with the name in the text field.  -1 means no match
var gExistingName = -1;
var gNeedSelection = false;
var gWidth = 0;
var gInvalidTime = false;
var gAlreadyResized = false;

var sortedBy = 0;

// GetInt 1 bit values
// 1   = add current session - used when recovering from crash
// 2   = multiselect enable  - true if allowed to choose multiple sessions (used for deleting)
// 4   = ignorable           - Displays ignore checkbox
// 8   = autosaveable        - Displays autosave checkbox
// 16  = remove              - true if deleting session(s)
// 32  = grouping            - true if changing grouping
// 64  = append/replace      - true if displaying the append/replace radio group, false otherwise
// 256 = allow name replace  - true if double clicking a session name on save will replace existing session, but use default session name.
//                                  (This is currently only settable via a userChrome.js script).

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
// 16 = tabprompt            - tabprompt checbox checked
// 32 = append flag          - true if append session, false if replace

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
				var consoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
				consoleService.logStringMessage("Session Manager: Override function error. " + ex);
			}
		}
		else {
			var consoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
			consoleService.logStringMessage("Session Manager: Passed override function parameter is not a function.");
		}
		if (!sessions || !_isValidSessionList(sessions)) {
			window.close();
			return;
		}
	}
	else {
		sessions = this.getSessions();
	}
	
	if (gParams.GetInt(1) & 1) // add a "virtual" current session
	{
		sessions.unshift({ name: this._string("current_session"), fileName: "*" });
	}
	
	gTabTree = _("tabTree");
	gSessionTree = _("session_tree");
	gSessionTree.selType = (gParams.GetInt(1) & 2)?"multiple":"single";
	
	// Do not allow overwriting of open window or browser sessions
	gBannedNames = this.getWindowSessions();
	var currentSession = this.getPref("_autosave_values", "").split("\n")[0];
	if (currentSession) gBannedNames[currentSession.trim().toLowerCase()] = true;
	
	// hide/show the "Don't show [...] again" checkbox
	_("checkbox_ignore").hidden = !(gParams.GetInt(1) & 4);

	// hide/show the Autosave checkboxes
	_("checkbox_autosave").hidden = !(gParams.GetInt(1) & 8);
	_("save_every").hidden = _("checkbox_autosave").hidden || !_("checkbox_autosave").checked;
	
	// hide/show the append/replace radio buttons
	_("radio_append_replace").hidden = !(gParams.GetInt(1) & 64);
	_("radio_append_replace").selectedIndex = this.getPref("overwrite", false) ? 1 : 0;

	gBackupGroupName = this._string("backup_sessions");
	gBackupNames[this._string("backup_session").trim().toLowerCase()] = true;
	gBackupNames[this._string("autosave_session").trim().toLowerCase()] = true;
	
	var deleting = (gParams.GetInt(1) & 16);
	var saving = (gParams.GetInt(1) & 8);
	var grouping = (gParams.GetInt(1) & 32);
	var groupCount = 0;
	var selected;
	sessions.forEach(function(aSession) {
		var trimName = aSession.name.trim().toLowerCase();
		// ban backup session names
		if (aSession.backup) gBackupNames[trimName] = true;
		// Don't display loaded sessions in list for delete or save or backup items in list for save or grouping
		if (!((aSession.backup && (saving || grouping)) || ((gBannedNames[trimName]) && (saving || deleting))))
		{
			// get window and tab counts and group name for crashed session
			if (aSession.fileName == "*") {
				aSession.group = gBackupGroupName;
				var counts = gParams.GetString(7).split(",");
				aSession.windows = counts[0];
				aSession.tabs = counts[1];
			}
			
			// Break out Autosave variables
			if (aSession.autosave) {
				var autosave = aSession.autosave.split("/");
				aSession.autosave = autosave[0];
				aSession.autosave_time = autosave[1];
			}
			
			// Mark if session loaded
			aSession.loaded = gBannedNames[trimName] || null;
			
			// Flag latest session
			if ((sessions.latestTime && (sessions.latestTime == aSession.timestamp) && !(gParams.GetInt(1) & 1)) || (aSession.fileName == "*")) {
				aSession.latest = true;
			}

			// select passed in item (if any)
			if (aSession.fileName == gParams.GetString(3)) selected = gSessionTreeData.length;

			// Add session to name list
			gSessionNames[trimName] = gSessionTreeData.length;
			
			// Push to Tree database and backup
			gSessionTreeData.push(aSession);
			
			// Build group menu list
			if (aSession.group && !aSession.backup) {
				var regExp = new RegExp("^" + aSession.group + "|," + aSession.group + "$|," + aSession.group + ",");
				if (!regExp.test(gGroupNames.toString())) {
					gGroupNames[groupCount++] = aSession.group.trim();
				}
			}
		}
	}, this);
	
	// Make a copy of array
	gOriginalSessionTreeData = gSessionTreeData.slice(0);
	
	// Display Tree
	gSessionTree.view = sessionTreeView;
	
	// select passed in item (if any)
	if (selected != undefined) gSessionTree.view.selection.select(selected);

	// If there is a text box label, enable text boxes
	if (gParams.GetString(4))
	{
		_("text_container").hidden = false;
		setDescription(_("text_label"), gParams.GetString(4));
		
		// If renaming and name already entered, disable the session selection list
		if (gParams.GetString(3) && !gParams.GetString(5)) gSessionTree.disabled = true;

		// group text input is enabled when saving or group changing
		if ((gParams.GetInt(1) & 32) || gParams.GetString(5)) 
		{
			_("group-text-container").hidden = false;
			ggMenuList = _("group_menu_list");

			// Pre-populate Group Menu
			for (var i in gGroupNames) {
				ggMenuList.appendItem(gGroupNames[i]);
			}
		}
				
		// session text input is enabled when not group chaning (i.e., when saving or renaming)
		if (!(gParams.GetInt(1) & 32)) 
		{
			_("session-text-container").hidden = false;
			gTextBox = _("text_box");
		
			// Pre-populate the text box with default session name if saving and the name is not banned or already existing.
			// Otherwise disable accept button
			var trimname = gParams.GetString(6).trim().toLowerCase();
			if (gParams.GetString(5) && !gBannedNames[trimname] && ((gSessionNames[trimname] == undefined) || (gParams.GetInt(1) & 256)))
			{
				onTextboxInput(gParams.GetString(6));
			}
			else gAcceptButton.disabled = true;
		}
	}
	
	// Force user to make a selection if no text or group box or not saving (i.e., deleting or renaming)
	if ((gNeedSelection = !gTextBox || !ggMenuList || !gParams.GetString(5)) || (gParams.GetInt(1) & 256))
	{
		gSessionTree.addEventListener("select", onSessionTreeSelect, false);
		onSessionTreeSelect();
	}
	
	if (gSessionTree.hasAttribute("height"))
	{
		gSessionTree.height = gSessionTree.getAttribute("height");
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
	
	// only persist tree heights is neither is collapsed to prevent "giant" trees
	if (_("tree_splitter").getAttribute("state") != "collapsed") {
		// persist session tree height if it has a height
		if (gSessionTree && gSessionTree.treeBoxObject.height > 0) {
			persist(gSessionTree, "height", gSessionTree.treeBoxObject.height);
		}
		// persist tab tree height if it has a height, subtract 13 from the clicknoteHeight because it overcalculates by 13.
		if (gTabTree && gTabTree.treeBoxObject.height > 0) {
			persist(gTabTree, "height", gTabTree.treeBoxObject.height);
			var clickNoteHeight = parseInt(window.getComputedStyle(_("ctrl_click_note"), null).height);
			clickNoteHeight = isNaN(clickNoteHeight) ? 0 : clickNoteHeight - 13;
			persist(gTabTree, "height", gTabTree.treeBoxObject.height + clickNoteHeight);
		}
	}
	
	if (!gAllTabsChecked) storeSession();
	
	gParams.SetInt(1, ((_("checkbox_ignore").checked)?4:0) | ((_("checkbox_autosave").checked)?8:0) |
	                  ((!gAllTabsChecked)?16:0) | ((_("radio_append").selected)?32:0));
	if (_("checkbox_autosave").checked) gParams.SetInt(2, parseInt(_("autosave_time").value.trim()));
};

function onSessionTreeClick(aEvent)
{
	if ((aEvent.button == 0) && !aEvent.metaKey && !aEvent.ctrlKey && !aEvent.shiftKey && !aEvent.altKey) {
		if (aEvent.target.nodeName=="treechildren") {
			switch (aEvent.type) {
				case "click":
					if (gTextBox && !(gParams.GetInt(1) & 256)) onTextboxInput(gSessionTreeData[gSessionTree.currentIndex].name);
					break;
				case "dblclick":
					gAcceptButton.doCommand();
					break;
			}
		}
		else if ((aEvent.type == "click") && (aEvent.target.nodeName == "treecol")) {
			var types = { name: 0, group: 1, win_count: 2, tab_count: 3 };
			var which = types[aEvent.target.id];
			
			// If not already sorted, sortedBy will be 0.  Otherwise it is which + 1 if sorted or -(which + 1) if inversely sorted
			var flag = (Math.abs(sortedBy) == (which + 1)) ? (-sortedBy / Math.abs(sortedBy)) : 1
			
			// Save selected items so they can be restored
			var selectedFileNames = {};
			var start = new Object();
			var end = new Object();
			var numRanges = gSessionTree.view.selection.getRangeCount();

			for (var t = 0; t < numRanges; t++) {
				gSessionTree.view.selection.getRangeAt(t,start,end);
				for (var v = start.value; v <= end.value; v++){
					selectedFileNames[gSessionTreeData[v].fileName] = true;
				}
			}
			
			// Clear all selected items
			gSessionTree.view.selection.clearSelection();
			
			// If inversely sorted and user clicks header again, go back to original order
			if (flag && sortedBy < 0) {
				flag = 0;
				gSessionTreeData = gOriginalSessionTreeData.slice(0);
			}
			else {
				// Sort depending on which header is clicked
				switch (which) {
					case 0:
						gSessionTreeData = gSessionTreeData.sort(function(a, b) { 
							return flag * (a.name.toLowerCase().localeCompare(b.name.toLowerCase())); 
						});
						break;
					case 1:
						gSessionTreeData = gSessionTreeData.sort(function(a, b) { 
							return flag * (a.group.toLowerCase().localeCompare(b.group.toLowerCase())); 
						});
						break;
					case 2:
						gSessionTreeData = gSessionTreeData.sort(function(a, b) { 
							return flag * (parseInt(a.windows) - parseInt(b.windows)); 
						});
						break;
					case 3:
						gSessionTreeData = gSessionTreeData.sort(function(a, b) { 
							return flag * (parseInt(a.tabs) - parseInt(b.tabs)); 
						});
						break;
				}
			}
			
			// Recreate Session List index and restore selected items
			for (var i=0; i<gSessionTreeData.length; i++) {
				var trimName = gSessionTreeData[i].name.trim().toLowerCase();
				gSessionNames[trimName] = i;
				
				if (selectedFileNames[gSessionTreeData[i].fileName]) {
					gSessionTree.view.selection.toggleSelect(i);
				}
			}
			sortedBy = flag * (which + 1);

			// update header arrorws			
			for (var i=0; i < aEvent.target.parentNode.childNodes.length; i++) {
				var sortText = flag ? ((flag>0) ? "ascending" : "descending") : "natural";
				aEvent.target.parentNode.childNodes[i].setAttribute("sortDirection", ((aEvent.target.parentNode.childNodes[i] == aEvent.target) ? sortText : "natural"))
			}
			
			// Redraw the tree - Needed for OS X
			gSessionTree.treeBoxObject.invalidate();
		}
	}
}

function onSessionTreeKeyPress(aEvent)
{
	if (gTextBox && (aEvent.keyCode == aEvent.DOM_VK_RETURN) && (gSessionTree.view.selection.count > 0)) {
		onTextboxInput(gSessionTreeData[gSessionTree.currentIndex].name);
		aEvent.preventDefault();
	}
}

function onSessionTreeSelect()
{
	// If no session name or group name text box, disable the accept button if nothing selected.
	// Otherwise isAcceptable when changing groups or onTextboxInput otherwise.
	if (!gTextBox && !ggMenuList)
	{
		gAcceptButton.disabled = gSessionTree.view.selection.count == 0;
		
		// save current session tree height before doing any unhiding (subtract one since one gets added for some reason)
		var currentSessionTreeHeight = gSessionTree.treeBoxObject.height - 1;
		
		// hide tab tree and splitter if nothing selected or multiple selection is enabled (deleting)
		// hide the click note if append/replace buttons are displayed (manual load)
		var hideTabTree = gAcceptButton.disabled || (gParams.GetInt(1) & 2);
		_("tree_splitter").hidden = _("tabTreeBox").hidden = hideTabTree;
		_("ctrl_click_note").hidden = hideTabTree || !(gParams.GetInt(1) & 64);
		
		// if displaying the tab tree, initialize it and then, if the tab tree was hidden, 
		// resize the window based on the current persisted height of the tab tree and the
		// current session tree height.
		if (!hideTabTree) {
			initTreeView(gSessionTreeData[gSessionTree.currentIndex].fileName);
			if (!gAlreadyResized) {
				if (gTabTree.hasAttribute("height"))
				{
					gTabTree.height = gTabTree.getAttribute("height");
				}
				gSessionTree.height = currentSessionTreeHeight;
				gAlreadyResized = true;
				window.sizeToContent();
			}
		}
	}
	else
	{
		if (gTextBox) onTextboxInput();
		else isAcceptable();
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
	
	gExistingName = (gSessionNames[input] != undefined) ? gSessionNames[input] : -1;
	var newWeight = !!((gExistingName >= 0) || ((gParams.GetInt(1) & 256) && gSessionTree.view.selection.count > 0));
	
	if (!_("checkbox_autosave").hidden) {
		var currentChecked = _("checkbox_autosave").checked;
		if (gExistingName >= 0) {
			_("checkbox_autosave").checked = gSessionTreeData[gExistingName].autosave != "false";
			_("autosave_time").value = gSessionTreeData[gExistingName].autosave_time;
		}
		else {
			_("checkbox_autosave").checked = false;
			_("autosave_time").value = "";
		}
		if (currentChecked != _("checkbox_autosave").checked) _save_every_update();
	}
	
	if (!gNeedSelection && oldWeight != newWeight)
	{
		gAcceptButton.label = (newWeight && gParams.GetString(5))?gParams.GetString(5):gParams.GetString(2);
		gAcceptButton.style.fontWeight = (newWeight)?"bold":"";
	}

	// Highlight matching item when accept label changes to replace and copy in group value (only when saving and not replacing name)
	if (newWeight && gParams.GetString(5) && !(gParams.GetInt(1) & 256)) {
		gSessionTree.view.selection.select(gExistingName);
		if (ggMenuList) ggMenuList.value = gSessionTreeData[gExistingName].group;
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
	
	gAcceptButton.disabled = gInvalidTime || badSessionName || badGroupName || (gNeedSelection && (gSessionTree.view.selection.count == 0 || (gExistingName >= 0)));
}

function onAcceptDialog()
{
	gParams.SetInt(0, 1);
	if (gNeedSelection || ((gParams.GetInt(1) & 256) && gSessionTree.view.selection.count > 0))
	{
		var selectedFileNames = [];
		var start = new Object();
		var end = new Object();
		var numRanges = gSessionTree.view.selection.getRangeCount();

		for (var t = 0; t < numRanges; t++) {
			gSessionTree.view.selection.getRangeAt(t,start,end);
			for (var v = start.value; v <= end.value; v++){
				selectedFileNames.push(gSessionTreeData[v].fileName);
			}
		}
		gParams.SetString(3, selectedFileNames.join("\n"));
	}
	else if (gExistingName >= 0)
	{
		gParams.SetString(3, gSessionTreeData[gExistingName].fileName);
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
		aObj.appendChild(document.createElement("description")).textContent = aLine;
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
		var consoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
		consoleService.logStringMessage("Session Manager: Override function returned an invalid session list.");
		return false;
	}
	return true;
}

function _save_every_update()
{
	var checked = _('checkbox_autosave').checked;
	
	_('save_every').hidden = !checked;
	
	// resize window
	if (checked) {
		this._save_every_height = parseInt(window.getComputedStyle(_('save_every'), "").height);
		if (isNaN(this._save_every_height)) this._save_every_height = 0;
		window.innerHeight += this._save_every_height;
	}
	else {
		if (this._save_every_height) window.innerHeight -= this._save_every_height;
	}
}

function isNumber(aTextBox)
{
	gInvalidTime = !/^([1-9]\d*)?$/.test(aTextBox.value);
	aTextBox.setAttribute("badname", gInvalidTime ? "true" : "false");
	
	isAcceptable();
}

// Tree controller

var sessionTreeView = {
	_atoms: {},
	_getAtom: function(aName)
	{
		if (!this._atoms[aName]) {
			var as = Components.classes["@mozilla.org/atom-service;1"].getService(Components.interfaces.nsIAtomService);
			this._atoms[aName] = as.getAtom(aName);
		}
		return this._atoms[aName];
	},

	treeBox: null,
	selection: null,

	get rowCount()                     { return gSessionTreeData.length; },
	setTree: function(treeBox)         { this.treeBox = treeBox; },
	getCellText: function(idx, column) { 
		switch(column.id) {
			case "name":
				return gSessionTreeData[idx].name;
				break;
			case "group":
				return gSessionTreeData[idx].group;
				break;
			case "win_count":
				return gSessionTreeData[idx].windows;
				break;
			case "tab_count":
				return gSessionTreeData[idx].tabs;
				break;
		}
		return null;
	},
	canDrop: function(idx, orient)      { return false; },
	isContainer: function(idx)          { return false; },
	isContainerOpen: function(idx)      { return false; },
	isContainerEmpty: function(idx)     { return false; },
	isSelectable: function(idx, column) { return false; },
	isSeparator: function(idx)          { return false; },
	isSorted: function()                { return sortedBy != 0; },
	isEditable: function(idx, column)   { return false; },
	getLevel: function(idx)             { return 0; },
	getParentIndex: function(idx)       { return -1; },
	getImageSrc: function(idx, column)  { return null; },

	hasNextSibling: function(idx, after) {
		return (idx <= after) && (idx < gSessionTreeData.length - 1) && (after < gSessionTreeData.length - 1);
	},

	getCellProperties: function(idx, column, prop) {
		if ((column.id == "group") && (gSessionTreeData[idx].backup)) 
			prop.AppendElement(this._getAtom("disabled"));
		if (gSessionTreeData[idx].latest) 
			prop.AppendElement(this._getAtom("latest"));
		if (gSessionTreeData[idx].loaded)
			prop.AppendElement(this._getAtom("disabled"));
		if (gSessionTreeData[idx].autosave)
			prop.AppendElement(this._getAtom(gSessionTreeData[idx].autosave));
	},

	getRowProperties: function(idx, prop) {
		if (idx % 2 != 0)
			prop.AppendElement(this._getAtom("alternate"));
	},

	drop: function(row, orient) { },
	getCellValue: function(idx, column) { },
	getProgressMode : function(idx, column) { },
	toggleOpenState: function(idx) { },
	cycleHeader: function(column) { },
	cycleCell: function(idx, column) { },
	selectionChanged: function() { },
	setCellValue: function() { },
	setCellText: function() { },
	performAction: function(action) { },
	performActionOnCell: function(action, index, column) { },
	performActionOnRow: function(action, index) { },
	getColumnProperties: function(column, prop) { }
};