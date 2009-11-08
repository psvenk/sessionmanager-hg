Components.utils.import("resource://sessionmanager/modules/utils.jsm");

function dumpnl(msg) {
	dump(msg + "\n");
}

var sessionTreeView = {
	treeBox: null,
	selection: null,
	rowCount: 0,

	sessions: null,
	sessionExpanded: [],
	childRow: {
		autosave: "",
		windows: "",
		tabs: "",
		timestamp: "",
		name: "Window names here"
	},
	atom_latest: null,
	atom_autosave: null,

	setData: function(data) {
		this.sessions = data;
		for (var i = 0; i < data.length; ++i) {
			this.sessionExpanded[i] = false;
		}
		this.rowCount = data.length;
		dumpnl("rowCount = " + data.length)
		var aserv=Components.classes["@mozilla.org/atom-service;1"]
			.getService(Components.interfaces.nsIAtomService);
		this.atom_latest = aserv.getAtom("latest");
		this.atom_autosave = aserv.getAtom("autosave");
		if (this.treebox)
			this.treebox.invalidate();
	},
	setTree: function(treeBox) {
		dumpnl("setTree(" + treeBox + ")");
		this.treeBox = treeBox;
	},
	getRowWhere: function(predicate) {
		idx = 0;
		for (var i = 0; i < this.sessions.length; ++i) {
			var tmp = {idx: idx, index: i, isContainer: true, data: this.sessions[i]};
			if (predicate(tmp))
				return tmp;
			if (this.sessionExpanded[i]) {
				++idx;
				var tmp = {idx: idx, isContainer: false, data: this.childRow};
				if (predicate(tmp))
					return tmp;
			}
			++idx;
		}
		dumpnl("getRowWhere: NOT FOUND")
		return {};
	},
	getRow: function(idx) {
		for (var i = 0; i < this.sessions.length; ++i) {
			if (idx-- == 0)
				return {index: i, isContainer: true, data: this.sessions[i]};
			if (this.sessionExpanded[i] && idx-- == 0)
				return {isContainer: false, data: this.childRow};
		}
		dumpnl("getRow: NOT FOUND")
		return {};
	},
	getCellText: function(idx, column) {
//		dumpnl("getCellText(" + idx + ", " + column.index + ")");
		var row = this.getRow(idx);
		var session = row.data;
		switch (column.index) {
			case 0: return "";
			case 1: return session.windows;
			case 2: return session.tabs;
			case 3:
				if (row.isContainer)
					return yyyy_mm_dd_hh_mm(new Date(session.timestamp));
				return session.timestamp;
			case 4: return session.name;
		}
		return "?";
	},
	getCellProperties: function(idx, column, prop) {
//		dumpnl("getCellProperties(" + idx + ", " + column.index + ")");
		var session = this.getRow(idx).data;
		if (this.sessions.latestName == session.name)
			prop.AppendElement(this.atom_latest);
		if (column.index == 0 && session.autosave == "session")
			prop.AppendElement(this.atom_autosave);
	},
	isContainer: function(idx) {
//		dumpnl("isContainer(" + idx + ")");
		return this.getRow(idx).isContainer;
	},
	isContainerOpen: function(idx) {
//		dumpnl("isContainerOpen(" + idx + ")");
		return this.sessionExpanded[this.getRow(idx).index];
	},
	isContainerEmpty: function(idx) {
//		dumpnl("isContainerEmpty(" + idx + ")");
		return false;
	},
	isSeparator: function(idx) {
//		dumpnl("isSeparator(" + idx + ")");
		return false;
	},
	isSorted: function() {
//		dumpnl("isSorted()");
		return false;
	},
	isEditable: function(idx, column) {
//		dumpnl("isEditable(" + idx + ", ", column + ")");
		return false;
	},
	getParentIndex: function(idx) {
//		dumpnl("getParentIndex(" + idx + ")");
		if (this.isContainer(idx)) return -1;
		return idx - 1;
	},
	getLevel: function(idx) {
//		dumpnl("getLevel(" + idx + ")");
		if (this.isContainer(idx)) return 0;
		return 1;
	},
	hasNextSibling: function(idx, after) {
		var row = this.getRow(idx);
		if (!row.isContainer)
			return false;
		return row.index < this.sessions.length - 1;
	},
	toggleOpenState: function(idx) {
		var row = this.getRow(idx);
		if (!row.isContainer)
			return;
		var isOpen = this.sessionExpanded[row.index];
		if (this.sessionExpanded[row.index])
			--this.rowCount;
		else
			++this.rowCount;

		this.treeBox.rowCountChanged(idx + 1, isOpen?-1:1);
		this.sessionExpanded[row.index] = !isOpen;
	},

	getImageSrc: function(idx, column) {},
	getProgressMode : function(idx,column) {},
	getCellValue: function(idx, column) {},
	cycleHeader: function(col, elem) {},
	selectionChanged: function() {},
	cycleCell: function(idx, column) {},
	performAction: function(action) {},
	performActionOnCell: function(action, index, column) {},
	getColumnProperties: function(column, element, prop) {},
	getRowProperties: function(idx, prop) {}
};


function zerofill(x, w) {
	return ("0000000000" + x).slice(-w);
}

function yyyy_mm_dd_hh_mm(d) {
	return (
		zerofill(d.getFullYear(),4) + "-" +
		zerofill(d.getMonth(),2) + "-" +
		zerofill(d.getDate(),2) + " " +
		zerofill(d.getHours(),2) + ":" +
		zerofill(d.getMinutes(),2)
	);
}

function getSelectedSession() {
	var tree = document.getElementById("sessiontree");
//	var view = tree.view;
	var view = sessionTreeView;
	var row = view.getRow(tree.currentIndex);
	if (row.isContainer)
		return row.data;
	return view.getRow(tree.currentIndex-1).data;
}

//
// Prompt handling
//
function stdMode() {
	document.getElementById("stdMode").setAttribute("disabled", false);

	var ok_button = document.getElementById("ok_button");
	ok_button.removeEventListener("command", ok_button.my_listener, false);

	document.getElementById("key_input_mode_cancel")
		.setAttribute("disabled", "true");

	document.getElementById("sessiontree").focus();

	document.getElementById("prompt").setAttribute("hidden", "true");
}

function onTextboxInput() {
	var sessions = sessionTreeView.sessions;
	var ok_button = document.getElementById("ok_button");
	var input = document.getElementById("text_box").value;
	for (var i = 0; i < sessions.length; ++i)
		if (sessions[i].name == input) {
			ok_button.setAttribute("disabled", "true");
			return;
		}
	ok_button.setAttribute("disabled", "false");
}

function inputMode(label, ok_func, initial_value) {
	document.getElementById("stdMode").setAttribute("disabled", true);

	var ok_button = document.getElementById("ok_button");
	ok_button.setAttribute("label", label);
	ok_button.addEventListener("command", ok_func, false);
	ok_button.my_listener = ok_func;

	document.getElementById("key_input_mode_cancel")
		.setAttribute("disabled", "false");

	document.getElementById("prompt").setAttribute("hidden", "false");

	var text_box = document.getElementById("text_box");
	text_box.value = initial_value? initial_value : getSelectedSession().name;
	text_box.focus();
}

function onCancel() {
	stdMode();
}

//
// Cmd handlers
//

function onCmdOpen(mode) {
	gSessionManager.load(getSelectedSession().fileName, mode);
}

function onCmdRenameOK() {
	var new_name = document.getElementById("text_box").value; 
	dumpnl(
		"rename '" + getSelectedSession().fileName + "' -> '" +
		new_name + "'"
	);
	gSessionManager.renameSession(getSelectedSession().fileName, new_name);
	sessionTreeView.setData(gSessionManager.getSessions());

	// select the renamed row again
	var r = sessionTreeView.getRowWhere(
		function(row){return row.data.name==new_name}
	);
	sessionTreeView.selection.select(r.idx);

	stdMode();
}

function onCmdRename(label) {
	inputMode(label, onCmdRenameOK);
}

function onCmdDelete() {
	dumpnl("delete " + getSelectedSession().fileName);
	gSessionManager.remove(getSelectedSession().fileName);
	sessionTreeView.setData(gSessionManager.getSessions());
	document.getElementById("sessiontree").focus();
}

function onCmdSaveOK() {
	alert("save as " + document.getElementById("text_box").value + " (not implemented yet)");
}

function onCmdSave() {
	var name = gSessionManager.getFormattedName(
		window.opener.content.document.title || "about:blank",
		new Date()
	);
	inputMode("Save", onCmdSaveOK, name);
}

function onCmdSaveWindowOK() {
	alert("save window as " + document.getElementById("text_box").value + " (not implemented yet)");
}

function onCmdSaveWindow() {
	var name = gSessionManager.getFormattedName(
		window.opener.content.document.title || "about:blank",
		new Date()
	);
	inputMode("Save Window", onCmdSaveWindowOK, "Window: " + name);
}

function onCmdOpenFolder() {
	gSessionManager.openFolder();
}

function isColumnCropped(tree, col) {
	var treebox = tree.boxObject;
	treebox.QueryInterface(Components.interfaces.nsITreeBoxObject);

	//var treebox = col.nsITreeColumns.nsITreeBoxObject;
	//var tree = ??

	for (var i = 0; i < tree.view.rowCount; ++i) {
		if (treebox.isCellCropped(i, col))
			return true;
	}
	return false;
}

// There must be a better way!!!
function autoFitColumn(tree, col) {
	var treebox = tree.boxObject;
	treebox.QueryInterface(Components.interfaces.nsITreeBoxObject);

	// this works for me...
	col.element.setAttribute("width", 93);
	return;

	var min_width = 0;
	while (isColumnCropped(tree, col)) {
		min_width = col.width;
		col.element.setAttribute("width", 2 * col.width);
		// sigh, without this alert the width isn't updated...
		alert("");
	}
	var max_width = col.width;

	// find the optimal width by binary search
	var w;
	while (min_width < max_width) {
		w = Math.round((min_width + max_width) / 2);
		col.element.setAttribute("width", w);

		// sigh, without this alert the width isn't updated...
		alert("");

		if (isColumnCropped(tree, col))
			min_width = w + 1;
		else
			max_width = w - 1;
	}
	if (min_width != max_width) dumpnl(min_width + "!=" + max_width);

	col.element.setAttribute("width", min_width);
}

function onLoad() {
	window.addEventListener("unload", onUnload, false);

	sessionTreeView.setData(gSessionManager.getSessions());
	document.getElementById("sessiontree").view = sessionTreeView;
	var tree = document.getElementById("sessiontree");

	autoFitColumn(tree, tree.columns.getColumnAt(3));
	
	tree.view.selection.select(0);
	tree.focus();
}

function onUnload() {
	dumpnl("unloaded");
}
