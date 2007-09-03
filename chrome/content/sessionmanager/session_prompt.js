var gParams = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
var gSessionList = null;
var gTextBox = null;
var gAcceptButton = null;
var gSessionNames = {};
var gExistingName = 0;
var gNeedSelection = false;

gSessionManager._onLoad = gSessionManager.onLoad;
gSessionManager.onLoad = function() {
	this._onLoad(true);
	
	_("mac_title").hidden = !/mac/i.test(navigator.platform);
	setDescription(_("session_label"), gParams.GetString(1));
	
	gAcceptButton = document.documentElement.getButton("accept");
	gAcceptButton.label = gParams.GetString(2) || gAcceptButton.label;
	
	var sessions = this.getSessions(true);
	if (gParams.GetInt(1) & 1) // add a "virtual" current session
	{
		sessions.unshift({ name: this._string("current_session"), fileName: "*" });
	}
	
	gSessionList = _("session_list");
	gSessionList.selType = (gParams.GetInt(1) & 2)?"multiple":"single";
	
	if (gParams.GetString(4)) // enable text box
	{
		_("text_container").hidden = false;
		setDescription(_("text_label"), gParams.GetString(4));
		gTextBox = _("text_box");
		
		sessions.forEach(function(aSession, aIx) {
			gSessionNames[aSession.name.trim().toLowerCase()] = aIx + 1;
		});
		
		onTextboxInput(gParams.GetString(6));
		if (gExistingName && !(gParams.GetInt(1) & 256))
		{
			gParams.SetString(3, sessions[gExistingName - 1].fileName);
			gTextBox.value = "";
			onTextboxInput();
		}
	}
	if (gParams.GetInt(1) & 4) // show the "Don't show [...] again" checkbox
	{
		_("checkbox_ignore").hidden = false;
	}

	if (gParams.GetInt(1) & 8) // show the Autosave checkbox
	{
		_("checkbox_autosave").hidden = false;
	}
	
	sessions.forEach(function(aSession) {
		if (!((gParams.GetInt(1) & 16) || (gParams.GetInt(1) & 8)) || aSession.name != this.getPref("_autosave_name"))
		{
			var label;
			// add counts if not current browsing session since current session has no counts.
			if (aSession.fileName != "*") label = aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")";
			else label = aSession.name;
			var item = gSessionList.appendItem(label, aSession.fileName);
			item.setAttribute("autosave", aSession.autosave);
			if (((sessions.latestName == aSession.name) && !(gParams.GetInt(1) & 1)) || (aSession.fileName == "*")) item.setAttribute("latest",true);
			if (aSession.fileName == gParams.GetString(3))
			{
				setTimeout(function(aItem) { gSessionList.selectItem(aItem); }, 0, item);
			}
		}
	}, this);
	
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
	persist(gSessionList, "height", gSessionList.boxObject.height);
	
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
	gAcceptButton.disabled = !input || gNeedSelection && (gSessionList.selectedCount == 0 || gExistingName);
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

String.prototype.trim = function() {
	return this.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ");
};

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
