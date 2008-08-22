gSessionManager._onLoad = gSessionManager.onLoad;
gSessionManager.onLoad = function() {
	this._onLoad(true);
	
	// for updating session list
	document.getElementById('session_tree').view = this.treeView;	
		
	// update list on notification
	gSessionManager.mObserverService.addObserver(gSessionManager, "sessionmanager-list-update", false);
}	

gSessionManager.onUnload = function() {
	window.removeEventListener("unload", gSessionManager.onUnload, false);
	gSessionManager.mObserverService.removeObserver(gSessionManager, "sessionmanager-list-update");
	gSessionManager.treeView = null;
}


var treeView = {
	defaultChildData: {
		backupFolder: { container: true, open: false, childCount: 0 },
		backupSeparator: { separator: true, row: 1 }
	},
	childData: null,
	visibleData: null,
	
	treeBox: null,
	selection: null,

	get rowCount()                     { return this.visibleData.length; },
	setTree: function(treeBox)         { this.treeBox = treeBox; },
	getCellText: function(idx, column) { return this.visibleData[idx]; },
	isContainer: function(idx)         { return this.childData[this.visibleData[idx]].container; },
	isContainerOpen: function(idx)     { return this.childData[this.visibleData[idx]].open; },
	isContainerEmpty: function(idx)    { return this.childData[this.visibleData[idx]].childCount; },
	isSeparator: function(idx)         { return this.childData[this.visibleData[idx]].separator; },
	isSorted: function()               { return false; },
	isEditable: function(idx, column)  { return false; },

	getImageSrc: function(idx, column) {},
	getProgressMode : function(idx,column) {},
	getCellValue: function(idx, column) {},
	cycleHeader: function(col, elem) {},
	selectionChanged: function() {},
	cycleCell: function(idx, column) {},
	performAction: function(action) {},
	performActionOnCell: function(action, index, column) {},
	getRowProperties: function(idx, column, prop) {},
	getCellProperties: function(idx, column, prop) {},
	getColumnProperties: function(column, element, prop) {},
	
	getParentIndex: function(idx) {
		if (this.isContainer(idx)) return -1;
		for (var t = idx - 1; t >= 0 ; t--) {
			if (this.isContainer(t)) return t;
		}
	},
	
	getLevel: function(idx) {
		if (this.isContainer(idx)) return 0;
		return 1;
	},
	
	hasNextSibling: function(idx, after) {
		var thisLevel = this.getLevel(idx);
		for (var t = idx + 1; t < this.visibleData.length; t++) {
			var nextLevel = this.getLevel(t)
			if (nextLevel == thisLevel) return true;
			else if (nextLevel < thisLevel) return false;
		}
	},

	updateList: function() {
		if (!this.allowUpdate) return;
		this.allowUpdate = false;
		var windowSessions = this.gSessionManager.getWindowSessions();
		var sessions = this.gSessionManager.getSessions(true);

		// clear out existing items from tree
		var children = document.getElementById("sessions");
		var backups = document.getElementById("backup_sessions");

		while (backups.childNodes.length) backups.removeChild(backups.childNodes[0]);
		while (children.childNodes.length > 2) children.removeChild(children.childNodes[2]);

		// Reset tree view data to default, keep backup container open status.
		if (treeView.childData) treeView.defaultChildData.backupFolder.open = treeView.childData.backupFolder.open;
		delete(treeView.childData);
		delete(treeView.visibleData);
		treeView.childData = treeView.defaultChildData;
		treeView.visibleData = [];
				
		// Build the tree items from session list
		sessions.forEach(function(aSession, aIx) {
			var treeitem = document.createElement("treeitem");
			var treerow = document.createElement("treerow");
			var name = document.createElement("treecell");
			var windowCount = document.createElement("treecell");
			var tabCount = document.createElement("treecell");
			
			// Properties are used for CSS dispaly stuff
			var property = "";
			if (aSession.autosave) {
				property = property + aSession.autosave + " ";
			}
			if ((sessions.latestBackUpTime == aSession.timestamp) || (sessions.latestTime == aSession.timestamp)) {
				property = property + "latest ";
			}
			if ((aSession.name == this.gSessionManager.mPref__autosave_name) || (windowSessions[aSession.name.trim().toLowerCase()])) {
				property = property + "disabled";
			}
			if (property) name.setAttribute("properties", property);
			
			name.setAttribute("label", aSession.name);
			windowCount.setAttribute("label", aSession.windows);
			tabCount.setAttribute("label", aSession.tabs);
			
			treerow.appendChild(name);
			treerow.appendChild(windowCount);
			treerow.appendChild(tabCount);
			
			treeitem.appendChild(treerow);
			
			if (aSession.backup) backups.appendChild(treeitem);
			else children.appendChild(treeitem);
			
			// Add session filename to TreeView data for easy lookup
			treeView.childData[aSession.name] = { filename: aSession.fileName, backup: aSession.backup  };
			if (aSession.backup) {
				treeView.childData.backupFolder.childCount++;
				// if backup Folder not in display list, add it and the separator
				if (!treeView.visibleData.backupFolder) {
					treeView.visibleData.unshift("backupSeparator");
					treeView.visibleData.unshift("backupFolder");
				}
				if (treeView.childData.backupFolder.open) {
					treeView.visibleData.splice(treeView.childData.backupSeparator.row++, 0, aSession.name);
				}
			}
			else {
				treeView.visibleData.push(aSession.name);
			}
		}, this);
		
		document.getElementById("backup_container").hidden = (backups.childNodes.length == 0);
		document.getElementById("backup_separator").hidden = (backups.childNodes.length == 0);
		
		this.allowUpdate = true;
	},
	
	handleEvent: function(aEvent) {
		// ignore non-enter key presses and right clicks
		if (((aEvent.type == "keypress") && (aEvent.keyCode != KeyEvent.DOM_VK_RETURN)) ||
		    ((aEvent.type == "click") && (aEvent.button == 2))) {
			return;
		}
		
		var index = document.getElementById("session_tree").currentIndex;
		var filename = treeView.getCellText(index);
		dump("index = " + index + ", filename = " + filename + "\n");
		
		//this.gSessionManager.load(filename, (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.shiftKey)?"newwindow":(event.ctrlKey || event.metaKey)?"append":"");
	}
}
