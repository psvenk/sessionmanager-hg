/*const*/ var gSessionManager = {
	mSessionStore: Components.classes["@mozilla.org/browser/sessionstore;1"].getService(Components.interfaces.nsISessionStore),
	mObserverService: Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService),
	mPrefRoot: Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefBranch2),
	mWindowMediator: Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator),
	mPromptService: Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService),
	mProfileDirectory: Components.classes["@mozilla.org/file/directory_service;1"].getService(Components.interfaces.nsIProperties).get("ProfD", Components.interfaces.nsILocalFile),
	mIOService: Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService),
	mComponents: Components,

	mObserving: ["sessionmanager:windowclosed", "sessionmanager:tabopenclose", "browser:purge-session-history", "quit-application"],
	mClosedWindowFile: "sessionmanager.dat",
	mBackupSessionName: "backup.session",
	mPromptSessionName: "?",
	mSessionExt: ".session",

	mSessionCache: {},

/* ........ Listeners / Observers.............. */

	onLoad_proxy: function()
	{
		this.removeEventListener("load", gSessionManager.onLoad_proxy, false);
		gSessionManager.onLoad();
	},

	onLoad: function(aDialog)
	{
		this.mBundle = document.getElementById("bundle_sessionmanager");
		this.mTitle = this._string("sessionManager");
		this.mEOL = this.getEOL();
		
		// This will force SessionStore to be enabled since Session Manager cannot work without SessionStore being 
		// enabled and presumably anyone installing Session Manager actually wants to use it.  It also forces 
		// resuming from a crash since Session Manager needs that enabled to display the crash dialogue box.
		this.setPref("browser.sessionstore.enabled", true, true);
		this.setPref("browser.sessionstore.resume_from_crash", true, true);
		
		this.mPrefBranch = this.mPrefRoot.QueryInterface(Components.interfaces.nsIPrefService).getBranch("extensions.sessionmanager.").QueryInterface(Components.interfaces.nsIPrefBranch2);
		this.mPrefBranch2 = this.mPrefRoot.QueryInterface(Components.interfaces.nsIPrefService).getBranch("browser.startup.").QueryInterface(Components.interfaces.nsIPrefBranch2);
		
		if (aDialog || this.mFullyLoaded)
		{
			return;
		}
		
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.addObserver(this, aTopic, false);
		}, this);
		
		this.mPref_backup_session = this.getPref("backup_session", 1);
		this.mPref_max_backup_keep = this.getPref("max_backup_keep", 0);
		this.mPref_max_closed_undo = this.getPref("max_closed_undo", 10);
		this.mPref_name_format = this.getPref("name_format", "%40t-%d");
		this.mPref_overwrite = this.getPref("overwrite", false);
		this.mPref_reload = this.getPref("reload", false);
		this.mPref_resume_session = this.getPref("resume_session", "");
		this.mPref_save_closed_tabs = this.getPref("save_closed_tabs", 0);
		this.mPref_save_window_list = this.getPref("save_window_list", false);
		this.mPref_session_list_order = this.getPref("session_list_order", 1);
		this.mPref_submenus = this.getPref("submenus", false);
		this.mPref__running = this.getPref("_running", false);
		this.mPrefBranch.addObserver("", this, false);
		this.mPrefBranch2.addObserver("page", this, false);

		gBrowser.addEventListener("TabClose", this.onTabClose_proxy, false);
		gBrowser.addEventListener("SSTabRestored", this.onTabRestored_proxy, false);

		this.synchStartup();
		this.recoverSession();
		this.updateToolbarButton();
		
		if (!this.mPref__running)
		{
			this.mPrefRoot.savePrefFile(null);
			this.setPref("_running", true);
		}
		this.mFullyLoaded = true;

		// Workaround for bug 366986
		// TabClose event fires too late to use SetTabValue to save the "image" attribute value and have it be saved by SessionStore
		// so make the image tag persistant so it can be read later from the xultab variable.
		this.mSessionStore.persistTabAttribute("image");
		
		// Workaround for bug 360408, remove when fixed and uncomment call to onWindowClose in onUnload
		eval("closeWindow = " + closeWindow.toString().replace("if (aClose)", "gSessionManager.onWindowClose(); $&"));
		
		// Have Tab Mix Plus use browser's built in undoCloseTab function.
		if (gBrowser.undoRemoveTab)
		{
			gBrowser.undoRemoveTab = function() { undoCloseTab(); }
		}
	},

	onUnload_proxy: function()
	{
		this.removeEventListener("unload", gSessionManager.onUnload_proxy, false);
		gSessionManager.onUnload();
	},

	onUnload: function()
	{
		this.mObserving.forEach(function(aTopic) {
			this.mObserverService.removeObserver(this, aTopic);
		}, this);
		this.mPrefBranch.removeObserver("", this);
		this.mPrefBranch2.removeObserver("page", this);
		
		gBrowser.removeEventListener("TabClose", this.onTabClose_proxy, false);
		gBrowser.removeEventListener("SSTabRestored", this.onTabRestored_proxy, false);
		
		if (this.mPref__running && this.getBrowserWindows().length == 0)
		{
			this._string_preserve_session = this._string("preserve_session");
			this._string_backup_session = this._string("backup_session");
			this._string_old_backup_session = this._string("old_backup_session");
			this._string_prompt_not_again = this._string("prompt_not_again");
			
			this.mTitle += " - " + document.getElementById("bundle_brand").getString("brandFullName");
			this.mBundle = null;
			
			this.shutDown();
		}
		
		this.mBundle = null;
		this.mFullyLoaded = false;

//		Uncomment the following when bug 360408 is fixed.
//		this.mSessionStore.setWindowValue(window, "already_restored", "")
//		var state = this.getSessionState(null, true);
//		this.appendClosedWindow(state);
//		this.mObserverService.notifyObservers(window, "sessionmanager:windowclosed", state);
	},

	observe: function(aSubject, aTopic, aData)
	{
		switch (aTopic)
		{
		case "sessionmanager:tabopenclose":
			if (aData == "tabclose")
			{
				this.mSessionStore.setWindowValue(window, "already_restored", true);
			}
			this.updateToolbarButton();
			break;
		case "sessionmanager:windowclosed":
			if (aSubject == window)
			{
				this.appendClosedWindow(aData);
			}
			this.updateToolbarButton();
			break;
		case "browser:purge-session-history":
			this.clearUndoData("all");
			this.delFile(this.getSessionDir(this.mBackupSessionName));
			break;
		case "nsPref:changed":
			this["mPref_" + aData] = this.getPref(aData);
			
			switch (aData)
			{
			case "max_closed_undo":
				if (this.mPref_max_closed_undo == 0)
				{
					this.clearUndoData("window", true);
				}
				else
				{
					var closedWindows = this.getClosedWindows();
					if (closedWindows.length > this.mPref_max_closed_undo)
					{
						this.storeClosedWindows(closedWindows.slice(0, this.mPref_max_closed_undo));
					}
				}
				break;
			case "page":
				this.synchStartup();
				break;
			case "resume_session":
				this.setResumeCurrent(this.mPref_resume_session == this.mBackupSessionName);
				break;
			}
			break;
		case "quit-application":
			if (this.getPref("_running"))
			{
				this.shutDown();
			}
			break;
		}
	},

	onTabClose_proxy: function(aEvent)
	{
		gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:tabopenclose", "tabclose");
	},

	onTabRestored_proxy: function(aEvent)
	{
		var browser = this.getBrowserForTab(aEvent.originalTarget);

		gSessionManager.onTabRestored();
		gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:tabopenclose", null);
				
		if (gSessionManager.mPref_reload && gSessionManager._allowReload && !browser.__SS_data && !gSessionManager.mIOService.offline)
		{
			var nsIWebNavigation = Components.interfaces.nsIWebNavigation;
			var webNav = browser.webNavigation;
			try
			{
				webNav = webNav.sessionHistory.QueryInterface(nsIWebNavigation);
			}
			catch (ex) { }
			webNav.reload(nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
		}
	},

	onTabRestored: function()
	{
		if (!this.mPref_save_closed_tabs && !this.mSessionStore.getWindowValue(window, "already_restored"))
		{
			this.mSessionStore.setWindowValue(window, "already_restored", true)
			this.mSessionStore.setWindowState(window, this.stripTabUndoData(this.mSessionStore.getWindowState(window)), true);
		}
	},

	onToolbarClick: function(aEvent, aButton)
	{
		if (aEvent.button == 1)
		{
			eval("var event = { shiftKey: true }; " + aButton.getAttribute("oncommand"));
		}
		else if (aEvent.button == 2 && aButton.getAttribute("disabled") != "true")
		{
			aButton.open = true;
		}
	},

	onWindowClose: function()
	{
		this.mSessionStore.setWindowValue(window, "already_restored", "")
		var state = this.getSessionState(null, true);
		this.mObserverService.notifyObservers(window, "sessionmanager:windowclosed", state);
	},

/* ........ Menu Event Handlers .............. */

	init: function(aPopup, aIsToolbar)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var separator = get_("separator");
		var startSep = get_("start-separator");
		
		for (var item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		var sessions = this.getSessions();
		sessions.forEach(function(aSession, aIx) {
			var key = (aIx < 9)?aIx + 1:(aIx == 9)?"0":"";
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", ((key)?key + ") ":"") + aSession.name);
			menuitem.setAttribute("oncommand", 'gSessionManager.load("' + aSession.fileName + '", (event.shiftKey && event.ctrlKey)?"overwrite":(event.shiftKey)?"newwindow":(event.ctrlKey)?"append":"");');
			menuitem.setAttribute("onclick", 'if (event.button == 1) gSessionManager.load("' + aSession.fileName + '", "newwindow");');
			menuitem.setAttribute("accesskey", key);
			aPopup.insertBefore(menuitem, separator);
		});
		separator.hidden = (sessions.length == 0);
		this.setDisabled(separator.nextSibling, separator.hidden);
		this.setDisabled(separator.nextSibling.nextSibling, separator.hidden);
		
		try
		{
			get_("resume").setAttribute("checked", this.doResumeCurrent());
			get_("overwrite").setAttribute("checked", this.mPref_overwrite);
			get_("reload").setAttribute("checked", this.mPref_reload);
		}
		catch (ex) { } // not available for Firefox
		
		var undoMenu = get_("undo-menu");
		while (aPopup.lastChild != undoMenu)
		{
			aPopup.removeChild(aPopup.lastChild);
		}
		
		var undoDisabled = (this.mPref_max_closed_undo == 0 && this.getPref("browser.sessionstore.max_tabs_undo", 10, true) == 0);
		var divertedMenu = aIsToolbar && document.getElementById("sessionmanager-undo");
		var canUndo = !undoDisabled && !divertedMenu && this.initUndo(undoMenu.firstChild);
		
		undoMenu.hidden = undoDisabled || divertedMenu || !this.mPref_submenus;
		undoMenu.previousSibling.hidden = !canUndo && undoMenu.hidden;
		this.setDisabled(undoMenu, !canUndo);
		
		if (!this.mPref_submenus && canUndo)
		{
			for (item = undoMenu.firstChild.firstChild; item; item = item.nextSibling)
			{
				aPopup.appendChild(item.cloneNode(true));
			}
		}
		
		// in case the popup belongs to a collapsed element
		aPopup.style.visibility = "visible";
	},

	uninit: function(aPopup)
	{
		aPopup.style.visibility = "";
	},

	save: function(aName, aFileName, aOneWindow)
	{
		var values = { text: this.getFormattedName(content.document.title || "about:blank", new Date()) || (new Date()).toLocaleString() };
		if (!aName)
		{
			if (!this.prompt(this._string("save2_session"), this._string("save_" + ((aOneWindow)?"window":"session") + "_ok"), values, this._string("save_" + ((aOneWindow)?"window":"session")), this._string("save_session_ok2")))
			{
				return;
			}
			aName = values.text;
			aFileName = values.name;
		}
		if (aName)
		{
			var file = this.getSessionDir(aFileName || this.makeFileName(aName), !aFileName);
			try
			{
				this.writeFile(file, this.getSessionState(aName, aOneWindow, this.mPref_save_closed_tabs < 2));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
	},

	saveWindow: function(aName, aFileName)
	{
		this.save(aName, aFileName, true);
	},

	load: function(aFileName, aMode)
	{
		var state = this.readSessionFile(this.getSessionDir(aFileName));
		if (!state)
		{
			this.ioError();
			return;
		}

		if (/^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.test(state))
		{
			state = state.split("\n")[3];
		}
		
		var newWindow = false;
		var overwriteTabs = true;
		var tabsToMove = null;
		var stripClosedTabs = !this.mPref_save_closed_tabs || (this.mPref_save_closed_tabs == 1 && (aMode != "startup"));

		// gSingleWindowMode is set if Tab Mix Plus's single window mode is enabled
		var TMP_SingleWindowMode = false;
	
		try
		{
			TMP_SingleWindowMode = gSingleWindowMode;
		}
		catch (ex) {}
		
		aMode = aMode || "default";
		if (aMode == "startup")
		{
			overwriteTabs = this.isCmdLineEmpty();
			tabsToMove = (!overwriteTabs)?Array.slice(gBrowser.mTabs):null;
		}
		else if (aMode == "append" || TMP_SingleWindowMode)
		{
			overwriteTabs = false;
		}
		else if (aMode == "newwindow" || (aMode != "overwrite" && !this.mPref_overwrite))
		{
			newWindow = true;
		}
		else
		{
			this.getBrowserWindows().forEach(function(aWindow) {
				if (aWindow != window) { aWindow.close(); }
			});
			this.mObserverService.notifyObservers(window, "sessionmanager:windowclosed", this.getSessionState(null, true));
		}
		
		setTimeout(function() {
			var tabcount = gBrowser.mTabs.length;
			gSessionManager.restoreSession((!newWindow)?window:null, state, overwriteTabs, true, stripClosedTabs);
			if (tabsToMove)
			{
				var endPos = gBrowser.mTabs.length - 1;
				tabsToMove.forEach(function(aTab) { gBrowser.moveTabTo(aTab, endPos); });
			}
			else if (!overwriteTabs && gBrowser.mTabs[tabcount])
			{
				if (/^\[Window1\]\n(?:(?!\[).*\n)*selected=(\d+)/m.test(state))
				{
					tabcount += parseInt(RegExp.$1) - 1;
				}
				setTimeout(function(aTab) {
					gBrowser.selectedTab = aTab;
				}, 100, gBrowser.mTabs[tabcount]);
			}
		}, 0);
	},

	rename: function()
	{
		var values = {};
		if (!this.prompt(this._string("rename_session"), this._string("rename_session_ok"), values, this._string("rename2_session")))
		{
			return;
		}
		var file = this.getSessionDir(values.name);
		var filename = this.makeFileName(values.text);
		var newFile = (filename != file.leafName)?this.getSessionDir(filename, true):null;
		
		try
		{
			this.writeFile(newFile || file, this.nameState(this.readSessionFile(file), values.text));
			if (newFile)
			{
				if (this.mPref_resume_session == file.leafName && this.mPref_resume_session != this.mBackupSessionName)
				{
					this.setPref("resume_session", filename);
				}
				this.delFile(file);
			}
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	},

	remove: function(aSession)
	{
		if (!aSession)
		{
			aSession = this.selectSession(this._string("remove_session"), this._string("remove_session_ok"), { multiSelect: true });
		}
		if (aSession)
		{
			aSession.split("\n").forEach(function(aFileName) {
				this.delFile(this.getSessionDir(aFileName));
			}, this);
		}
	},

	openFolder: function()
	{
		try
		{
			this.getSessionDir().launch();
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	},

	openOptions: function()
	{
		var dialog = this.mWindowMediator.getMostRecentWindow("SessionManager:Options");
		if (dialog)
		{
			dialog.focus();
			return;
		}
		
		openDialog("chrome://sessionmanager/content/options.xul", "_blank", "chrome,titlebar,centerscreen," + ((this.getPref("browser.preferences.instantApply", false, true))?"dialog=no":"modal"));
	},

	toggleResume: function()
	{
		this.setResumeCurrent(!this.doResumeCurrent());
	},

	toggleReload: function()
	{
		this.setPref("reload", !this.mPref_reload);
	},

	toggleOverwrite: function()
	{
		this.setPref("overwrite", !this.mPref_overwrite);
	},

/* ........ Undo Menu Event Handlers .............. */

	initUndo: function(aPopup, aStandAlone)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		var separator = get_("closed-separator");
		var label = get_("windows");
		
		for (var item = separator.previousSibling; item != label; item = separator.previousSibling)
		{
			aPopup.removeChild(item);
		}
		
		var closedWindows = this.getClosedWindows();
		closedWindows.forEach(function(aWindow, aIx) {
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", aWindow.name);
			menuitem.setAttribute("oncommand", 'gSessionManager.undoCloseWindow(' + aIx + ', (event.shiftKey && event.ctrlKey)?"overwrite":(event.ctrlKey)?"append":"");');
			aPopup.insertBefore(menuitem, separator);
		});
		label.hidden = (closedWindows.length == 0);
		
		var listEnd = get_("end-separator");
		for (item = separator.nextSibling.nextSibling; item != listEnd; item = separator.nextSibling.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		var closedTabs = this.mSessionStore.getClosedTabData(window);
		var mClosedTabs = [];
		closedTabs = eval(closedTabs);
		closedTabs.forEach(function(aValue, aIndex) {
			mClosedTabs[aIndex] = { title:aValue.title, image:null }
			if (aValue.state.xultab)
			{
				var xultabData = aValue.state.xultab.split(" ");
				xultabData.forEach(function(bValue, bIndex) {
					var data = bValue.split("=");
					if (data[0] == "image") {
						mClosedTabs[aIndex].image = data[1];
					}
				}, this);
			}
		}, this);

		mClosedTabs.forEach(function(aTab, aIx) {
			var menuitem = document.createElement("menuitem");
			menuitem.setAttribute("class", "menuitem-iconic bookmark-item");
			menuitem.setAttribute("image", aTab.image);
			menuitem.setAttribute("label", aTab.title);
			menuitem.setAttribute("oncommand", 'undoCloseTab(' + aIx + ');');
			aPopup.insertBefore(menuitem, listEnd);
		});
		separator.nextSibling.hidden = (mClosedTabs.length == 0);
		separator.hidden = separator.nextSibling.hidden || label.hidden;
		
		var showPopup = closedWindows.length + mClosedTabs.length > 0;
		
		if (aStandAlone)
		{
			if (!showPopup)
			{
				this.updateToolbarButton(false);
				setTimeout(function(aPopup) { aPopup.parentNode.open = false; }, 0, aPopup);
			}
			else
			{
				aPopup.style.visibility = "visible";
			}
		}
		
		return showPopup;
	},

	uninitUndo: function(aPopup)
	{
		aPopup.style.visibility = "";
	},

	undoCloseWindow: function(aIx, aMode)
	{
		var closedWindows = this.getClosedWindows();
		if (closedWindows[aIx || 0])
		{
			var state = closedWindows.splice(aIx || 0, 1)[0].state;
			this.storeClosedWindows(closedWindows);
			
			// gSingleWindowMode is set if Tab Mix Plus's single window mode is active
			try
			{
				if (gSingleWindowMode) aMode = "append";
			}
			catch (ex) {}

			if (aMode == "overwrite")
			{
				this.mObserverService.notifyObservers(window, "sessionmanager:windowclosed", this.getSessionState(null, true));
			}
			else if (aMode == "append")
			{
				state = this.stripTabUndoData(state);
			}
			
			this.restoreSession((aMode == "overwrite" || aMode == "append")?window:null, state, aMode != "append", false, (this.mPref_save_closed_tabs < 2));
		}
	},

	clearUndoList: function()
	{
		var max_tabs_undo = this.getPref("browser.sessionstore.max_tabs_undo", 10, true);
		
		this.setPref("browser.sessionstore.max_tabs_undo", 0, true);
		this.setPref("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);

		gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:tabopenclose", null);

		this.clearUndoData("window");
	},
/* ........ User Prompts .............. */

	prompt: function(aSessionLabel, aAcceptLabel, aValues, aTextLabel, aAcceptExistingLabel)
	{
		var params = Components.classes["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Components.interfaces.nsIDialogParamBlock);
		aValues = aValues || {};
		
		params.SetNumberStrings(7);
		params.SetString(1, aSessionLabel);
		params.SetString(2, aAcceptLabel);
		params.SetString(3, aValues.name || "");
		params.SetString(4, aTextLabel || "");
		params.SetString(5, aAcceptExistingLabel || "");
		params.SetString(6, aValues.text || "");
		params.SetInt(1, ((aValues.addCurrentSession)?1:0) | ((aValues.multiSelect)?2:0) | ((aValues.ignorable)?4:0) | ((aValues.allowNamedReplace)?256:0));
		
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,modal,resizable,dialog=yes", params, (this.mFullyLoaded)?window:null);
		
		aValues.name = params.GetString(3);
		aValues.text = params.GetString(6);
		aValues.ignore = params.GetInt(1);
		
		return !params.GetInt(0);
	},

	selectSession: function(aSessionLabel, aAcceptLabel, aValues)
	{
		var values = aValues || {};
		
		if (this.prompt(aSessionLabel, aAcceptLabel, values))
		{
			return values.name;
		}
		
		return null;
	},

	ioError: function(aException)
	{
		this.mPromptService.alert((this.mBundle)?window:null, this.mTitle, (this.mBundle)?this.mBundle.getFormattedString("io_error", [(aException)?aException.message:this._string("unknown_error")]):aException);
	},

	openWindow: function(aChromeURL, aFeatures, aArgument, aParent)
	{
		if (!aArgument || typeof aArgument == "string")
		{
			var argString = Components.classes["@mozilla.org/supports-string;1"].createInstance(Components.interfaces.nsISupportsString);
			argString.data = aArgument || "";
			aArgument = argString;
		}
		
		return Components.classes["@mozilla.org/embedcomp/window-watcher;1"].getService(Components.interfaces.nsIWindowWatcher).openWindow(aParent || null, aChromeURL, "_blank", aFeatures, aArgument);
	},

	clearUndoListPrompt: function()
	{
		var dontPrompt = { value: false };
		if (this.getPref("no_clear_list_prompt") || this.mPromptService.confirmEx(null, this.mTitle, this._string("clear_list_prompt"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			this.clearUndoList();
			if (dontPrompt.value)
			{
				this.setPref("no_clear_list_prompt", true);
			}
		}
	},

/* ........ File Handling .............. */

	getProfileFile: function(aFileName)
	{
		var file = this.mProfileDirectory.clone();
		file.append(aFileName);
		return file;
	},

	getSessionDir: function(aFileName, aUnique)
	{
		var dir = this.getProfileFile("sessions");
		if (!dir.exists())
		{
			dir.create(this.mComponents.interfaces.nsIFile.DIRECTORY_TYPE, 0700);
		}
		if (aFileName)
		{
			dir.append(aFileName);
			if (aUnique)
			{
				var postfix = 1, ext = "";
				if (aFileName.slice(-this.mSessionExt.length) == this.mSessionExt)
				{
					aFileName = aFileName.slice(0, -this.mSessionExt.length);
					ext = this.mSessionExt;
				}
				while (dir.exists())
				{
					dir = dir.parent;
					dir.append(aFileName + "-" + (++postfix) + ext);
				}
			}
		}
		return dir.QueryInterface(this.mComponents.interfaces.nsILocalFile);
	},

	getSessions: function()
	{
		var sessions = [];
		
		var filesEnum = this.getSessionDir().directoryEntries.QueryInterface(this.mComponents.interfaces.nsISimpleEnumerator);
		while (filesEnum.hasMoreElements())
		{
			var file = filesEnum.getNext().QueryInterface(this.mComponents.interfaces.nsIFile);
			var fileName = file.leafName;
			var cached = this.mSessionCache[fileName] || null;
			if (cached && cached.time == file.lastModifiedTime)
			{
				sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp });
				continue;
			}
			if (/^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.test(this.readSessionFile(file)))
			{
				var timestamp = parseInt(RegExp.$2) || file.lastModifiedTime;
				sessions.push({ fileName: fileName, name: RegExp.$1, timestamp: timestamp });
				this.mSessionCache[fileName] = { name: RegExp.$1, timestamp: timestamp, time: file.lastModifiedTime };
			}
		}
		
		if (!this.mPref_session_list_order)
		{
			this.mPref_session_list_order = this.getPref("session_list_order", 1);
		}
		switch (Math.abs(this.mPref_session_list_order))
		{
		case 1: // alphabetically
			sessions = sessions.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
			break;
		case 2: // chronologically
			sessions = sessions.sort(function(a, b) { return a.timestamp - b.timestamp; });
			break;
		}
		
		return (this.mPref_session_list_order < 0)?sessions.reverse():sessions;
	},

	getClosedWindows: function()
	{
		var data = this.readFile(this.getProfileFile(this.mClosedWindowFile));
		return (data)?data.split("\n\n").map(function(aEntry) {
			var parts = aEntry.split("\n");
			return { name: parts.shift(), state: parts.join("\n") };
		}):[];
	},

	storeClosedWindows: function(aList)
	{
		var file = this.getProfileFile(this.mClosedWindowFile);
		if (aList.length > 0)
		{
			this.writeFile(file, aList.map(function(aEntry) {
				return aEntry.name + "\n" + aEntry.state;
			}).join("\n\n"));
		}
		else
		{
			this.delFile(file);
		}
		this.updateToolbarButton(aList.length + this.mSessionStore.getClosedTabCount(window)  > 0);
	},

	appendClosedWindow: function(aState)
	{
		if (this.mPref_max_closed_undo == 0 || Array.every(gBrowser.browsers, this.isCleanBrowser))
		{
			return;
		}
		
		var name = content.document.title || ((gBrowser.currentURI.spec != "about:blank")?gBrowser.currentURI.spec:this._string("untitled_window"));
		var windows = this.getClosedWindows();
		
		aState = aState.replace(/^\n+|\n+$/g, "").replace(/\n{2,}/g, "\n");
		windows.unshift({ name: name, state: aState });
		this.storeClosedWindows(windows.slice(0, this.mPref_max_closed_undo));
	},

	clearUndoData: function(aType, aSilent)
	{
		if (aType == "window" || aType == "all")
		{
			this.delFile(this.getProfileFile(this.mClosedWindowFile), aSilent);
		}
		this.updateToolbarButton((aType == "all")?false:undefined);
	},

	shutDown: function()
	{
		if (!this.mPref_save_window_list)
		{
			this.clearUndoData("window", true);
		}
		this.backupCurrentSession();
		this.delPref("_running");
		this.mPref__running = false;

		// Cleanup left over files from Crash Recovery
		if (this.getPref("extensions.crashrecovery.resume_session_once", false, true))
		{	
			this.delFile(this.getProfileFile("crashrecovery.dat"), true);
			this.delFile(this.getProfileFile("crashrecovery.bak"), true);
			this.delPref("extensions.crashrecovery.resume_session_once", true);
		}
	},

	backupCurrentSession: function()
	{
		var backup = this.getPref("backup_session", 1);
		if (backup == 2 && !this.getPref("browser.sessionstore.resume_session_once", false, true))
		{
			var dontPrompt = { value: false };
			backup = (this.mPromptService.confirmEx(null, this.mTitle, this._string_preserve_session || this._string("preserve_session"), this.mPromptService.BUTTON_TITLE_YES * this.mPromptService.BUTTON_POS_0 + this.mPromptService.BUTTON_TITLE_NO * this.mPromptService.BUTTON_POS_1, null, null, null, this._string_prompt_not_again || this._string("prompt_not_again"), dontPrompt) == 1)?-1:1;
			if (dontPrompt.value)
			{
				this.setPref("backup_session", (backup == -1)?0:1);
			}
		}
		if (backup > 0)
		{
			this.keepOldBackups();
			try
			{
				var state = this.getSessionState(this._string_backup_session || this._string("backup_session"));
				this.writeFile(this.getSessionDir(this.mBackupSessionName), state);
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
		else
		{
			this.delFile(this.getSessionDir(this.mBackupSessionName), true);
			this.keepOldBackups();
		}
	},

	keepOldBackups: function()
	{
		var backup = this.getSessionDir(this.mBackupSessionName);
		if (backup.exists() && this.mPref_max_backup_keep)
		{
			var oldBackup = this.getSessionDir(this.mBackupSessionName, true);
			var name = this.getFormattedName("", new Date(), this._string_old_backup_session || this._string("old_backup_session"));
			this.writeFile(oldBackup, this.nameState(this.readSessionFile(backup), name));
		}
		
		if (this.mPref_max_backup_keep != -1)
		{
			this.getSessions().filter(function(aSession) {
				return /^backup-\d+\.session$/.test(aSession.fileName);
			}).sort(function(a, b) {
				return b.timestamp - a.timestamp;
			}).slice(this.mPref_max_backup_keep).forEach(function(aSession) {
				this.delFile(this.getSessionDir(aSession.fileName), true);
			}, this);
		}
	},

	readSessionFile: function(aFile)
	{
		var state = this.readFile(aFile);
		
		// old crashrecovery file format
		if ((/\n\[Window1\]\n/.test(state)) && 
		    (/^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.test(state))) 
		{
			var name = RegExp.$1 || this._string("untitled_window");
			var timestamp = parseInt(RegExp.$2) || aFile.lastModifiedTime;
			state = state.substring(state.indexOf("[Window1]\n"), state.length);
			state = this.decodeOldFormat(state, true).toSource();
			state = state.substring(1,state.length-1);
			state = "[SessionManager]\nname=" + name + "\ntimestamp=" + timestamp + "\n" + state;
			this.writeFile(aFile, state);
		}
		
		return state;
	},

	readFile: function(aFile)
	{
		try
		{
			var stream = this.mComponents.classes["@mozilla.org/network/file-input-stream;1"].createInstance(this.mComponents.interfaces.nsIFileInputStream);
			stream.init(aFile, 0x01, 0, 0);
			var cvstream = this.mComponents.classes["@mozilla.org/intl/converter-input-stream;1"].createInstance(this.mComponents.interfaces.nsIConverterInputStream);
			cvstream.init(stream, "UTF-8", 1024, this.mComponents.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
			
			var content = "";
			var data = {};
			while (cvstream.readString(4096, data))
			{
				content += data.value;
			}
			cvstream.close();
			
			return content.replace(/\r\n?/g, "\n");
		}
		catch (ex) { }
		
		return null;
	},

	writeFile: function(aFile, aData)
	{
		var stream = this.mComponents.classes["@mozilla.org/network/file-output-stream;1"].createInstance(this.mComponents.interfaces.nsIFileOutputStream);
		stream.init(aFile, 0x02 | 0x08 | 0x20, 0600, 0);
		var cvstream = this.mComponents.classes["@mozilla.org/intl/converter-output-stream;1"].createInstance(this.mComponents.interfaces.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, this.mComponents.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
		
		cvstream.writeString(aData.replace(/\n/g, this.mEOL));
		cvstream.flush();
		cvstream.close();
	},

	delFile: function(aFile, aSilent)
	{
		if (aFile.exists())
		{
			try
			{
				aFile.remove(false);
			}
			catch (ex)
			{
				if (!aSilent)
				{
					this.ioError(ex);
				}
			}
		}
	},

/* ........ Conversion functions .............. */

	decodeOldFormat: function(aIniString, moveClosedTabs)
	{
		var rootObject = {};
		var obj = rootObject;
		var lines = aIniString.split("\n");
	
		for (var i = 0; i < lines.length; i++)
		{
			try
			{
				if (lines[i].charAt(0) == "[")
				{
					obj = this.ini_getObjForHeader(rootObject, lines[i]);
				}
				else if (lines[i] && lines[i].charAt(0) != ";")
				{
					this.ini_setValueForLine(obj, lines[i]);
				}
			}
			catch (ex)
			{
				throw new Error("Error at line " + (i + 1) + ": " + ex.description);
			}
		}
	
		// move the closed tabs to the right spot
		if (moveClosedTabs == true)
		{
			try
			{
				rootObject.windows.forEach(function(aValue, aIndex) {
					if (aValue.tabs && aValue.tabs[0]._closedTabs)
					{
						aValue["_closedTabs"] = aValue.tabs[0]._closedTabs;
						delete aValue.tabs[0]._closedTabs;
					}
				}, this);
			}
			catch (ex) {}
		}
	
		return rootObject;
	},

	ini_getObjForHeader: function(aObj, aLine)
	{
		var names = aLine.split("]")[0].substr(1).split(".");
	
		for (var i = 0; i < names.length; i++)
		{
			if (!names[i])
			{
				throw new Error("Invalid header: [" + names.join(".") + "]!");
			}
			if (/(\d+)$/.test(names[i]))
			{
				names[i] = names[i].slice(0, -RegExp.$1.length);
				var ix = parseInt(RegExp.$1) - 1;
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || [];
				aObj = aObj[ix] = aObj[ix] || {};
			}
			else
			{
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || {};
			}
		}
	
		return aObj;
	},

	ini_setValueForLine: function(aObj, aLine)
	{
		var ix = aLine.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aLine + "!");
		}
	
		var value = aLine.substr(ix + 1);
		if (value == "true" || value == "false")
		{
			value = (value == "true");
		}
		else if (/^\d+$/.test(value))
		{
			value = parseInt(value);
		}
		else if (value.indexOf("%") > -1)
		{
			value = decodeURI(value.replace(/%3B/gi, ";"));
		}
		
		var name = this.ini_fixName(aLine.substr(0, ix));
		if (name == "xultab")
		{
			//this.ini_parseCloseTabList(aObj, value);
		}
		else
		{
			aObj[name] = value;
		}
	},

	// This results in some kind of closed tab data being restored, but it is incomplete
	// as all closed tabs show up as "undefined" and they don't restore.  If someone
	// can fix this feel free, but since it is basically only used once I'm not going to bother.
	ini_parseCloseTabList: function(aObj, aCloseTabData)
	{
		var ClosedTabObject = {};
		var ix = aCloseTabData.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aCloseTabData + "!");
		}
		var serializedTabs = aCloseTabData.substr(ix + 1);
		serializedTabs = decodeURI(serializedTabs.replace(/%3B/gi, ";"));
		var closedTabs = serializedTabs.split("\f\f").map(function(aData) {
			if (/^(\d+) (.*)\n([\s\S]*)/.test(aData))
			{
				return { name: RegExp.$2, pos: parseInt(RegExp.$1), state: RegExp.$3 };
			}
			return null;
		}).filter(function(aTab) { return aTab != null; }).slice(0, this.getPref("browser.sessionstore.max_tabs_undo", 10, true));

		closedTabs.forEach(function(aValue, aIndex) {
			closedTabs[aIndex] = this.decodeOldFormat(aValue.state, false)
			closedTabs[aIndex] = closedTabs[aIndex].windows;
			closedTabs[aIndex] = closedTabs[aIndex][0].tabs;
		}, this);

		aObj["_closedTabs"] = [];

		closedTabs.forEach(function(aValue, aIndex) {
			aObj["_closedTabs"][aIndex] = eval(({ state : aValue[0].toSource() }));
		}, this);
	},

	ini_fixName: function(aName)
	{
		switch (aName)
		{
			case "Window":
				return "windows";
			case "Tab":
				return "tabs";
			case "Entry":
				return "entries";
			case "Child":
				return "children";
			case "Cookies":
				return "cookies";
			case "uri":
				return "url";
			default:
				return aName;
		}			
	},

/* ........ Preference Access .............. */

	getPref: function(aName, aDefault, aUseRootBranch)
	{
		try
		{
			var pb = (aUseRootBranch)?this.mPrefRoot:this.mPrefBranch;
			switch (pb.getPrefType(aName))
			{
				case pb.PREF_STRING:
					return pb.getCharPref(aName);
				case pb.PREF_BOOL:
					return pb.getBoolPref(aName);
				case pb.PREF_INT:
					return pb.getIntPref(aName);
			}
		}
		catch (ex) { }
		
		return aDefault;
	},

	setPref: function(aName, aValue, aUseRootBranch)
	{
		var pb = (aUseRootBranch)?this.mPrefRoot:this.mPrefBranch;
		switch (typeof aValue)
		{
		case "boolean":
			pb.setBoolPref(aName, aValue);
			break;
		case "number":
			pb.setIntPref(aName, parseInt(aValue));
			break;
		default:
			pb.setCharPref(aName, "" + aValue);
			break;
		}
	},

	delPref: function(aName, aUseRootBranch)
	{
		((aUseRootBranch)?this.mPrefRoot:this.mPrefBranch).deleteBranch(aName);
	},

/* ........ Miscellaneous Enhancements .............. */

	synchStartup: function()
	{
		var startup = this.getPref("browser.startup.page", 1, true);
		if (startup == 3) 
		{
			this.setPref("resume_session", this.mBackupSessionName);
		}
		else 
		{
			this.setPref("old_startup_page", startup);
			if (this.mPref_resume_session == this.mBackupSessionName)
			{
				this.setPref("resume_session", "");
			}
		}
	},

	recoverSession: function()
	{
		var recovering = this.getPref("_recovering");
		var recoverOnly = recovering || this.mPref__running || this.doResumeCurrent() || this.getPref("browser.sessionstore.resume_session_once", false, true);
		if (recovering)
		{
			this.delPref("_recovering");
			this.load(recovering, "startup");
		}
		else if (!recoverOnly && this.mPref_resume_session && this.getSessions().length > 0)
		{
			var values = { ignorable: true };
			var session = (this.mPref_resume_session == this.mPromptSessionName)?this.selectSession(this._string("resume_session"), this._string("resume_session_ok"), values):this.mPref_resume_session;
			if (session && this.getSessionDir(session).exists())
			{
				this.load(session, "startup");
			}
			if (values.ignore)
			{
				this.setPref("resume_session", session || "");
			}
		}
	},

	isCmdLineEmpty: function()
	{
		var homepage = null;
		
		switch (this.getPref("browser.startup.page", 1, true))
		{
		case 0:
			homepage = "about:blank";
			break;
		case 1:
			try
			{
				homepage = this.mPrefRoot.getComplexValue("browser.startup.homepage", Components.interfaces.nsIPrefLocalizedString).data;
			}
			catch (ex)
			{
				homepage = this.getPref("browser.startup.homepage", "", true);
			}
			break;
		}
		if (window.arguments.length > 0 && window.arguments[0].split("\n")[0] == homepage)
		{
			window.arguments.shift();
		}
		
		return (window.arguments.length == 0);
	},

	updateToolbarButton: function(aEnable)
	{
		var button = (document)?document.getElementById("sessionmanager-undo"):null;
		if (button)
		{
			var tabcount = 0;
			try {
				tabcount = this.mSessionStore.getClosedTabCount(window);
			} catch (ex) {}
			this.setDisabled(button, (aEnable != undefined)?!aEnable:tabcount == 0 && this.getClosedWindows().length == 0);
		}
	},

/* ........ Auxiliary Functions .............. */
	// Work around for bug 350558 which sometimes mangles the _closedTabs.state.entries array data
	fixBug350558: function(aState)
	{
		aState = eval("(" + aState + ")")
		aState.windows.forEach(function(aValue, aIndex) {
			if (aValue._closedTabs) {
				aValue._closedTabs.forEach(function(bValue, bIndex) {
					var oldEntries = bValue.state.entries;
					bValue.state.entries = [];
					try {
						for (var i = 0; oldEntries[i]; i++) {
							bValue.state.entries[i] = oldEntries[i];
						}
					}
					catch (ex) {}
				}, this);
			}
		}, this);
		aState = aState.toSource();
		return aState;
		
	},

	getSessionState: function(aName, aOneWindow, aNoUndoData)
	{
		var state = (aOneWindow)?this.mSessionStore.getWindowState(window):this.mSessionStore.getBrowserState();
		
		if (aNoUndoData)
		{
			state = this.stripTabUndoData(state);
		}
		else state = this.fixBug350558(state);
		
		return (aName != null)?this.nameState(("[SessionManager]\nname=" + (new Date()).toString() + "\ntimestamp=" + Date.now() + "\n" + state + "\n").replace(/\n\[/g, "\n$&"), aName || ""):state;
	},

	restoreSession: function(aWindow, aState, aReplaceTabs, aAllowReload, aStripClosedTabs)
	{
		if (!aWindow)
		{
			aWindow = this.openWindow(this.getPref("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				this.gSessionManager.restoreSession(this, aState, aReplaceTabs, aAllowReload, aStripClosedTabs);
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return;
		}

		if (aStripClosedTabs)
		{
			aState = this.stripTabUndoData(aState);
		}
		else aState = this.fixBug350558(aState);

		this._allowReload = aAllowReload;
		this._ignoreRemovedTabs = true;
		this.mSessionStore.setWindowState(aWindow || window, aState, aReplaceTabs || false);
		this.mSessionStore.setWindowValue(window, "already_restored", true)
		this._ignoreRemovedTabs = false;
		gSessionManager.mObserverService.notifyObservers(null, "sessionmanager:tabopenclose", null);
	},

	nameState: function(aState, aName)
	{
		if (!/^\[SessionManager\]/m.test(aState))
		{
			return "[SessionManager]\nname=" + aName + "\n" + aState;
		}
		return aState.replace(/^(\[SessionManager\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName; });
	},

	stripTabUndoData: function(aState)
	{
		aState = eval("(" + aState + ")")
		aState.windows[0]._closedTabs = [];
		return aState.toSource();
	},

	getFormattedName: function(aTitle, aDate, aFormat)
	{
		function cut(aString, aLength)
		{
			return aString.replace(new RegExp("^(.{" + (aLength - 3) + "}).{4,}$"), "$1...");
		}
		function toISO8601(aDate)
		{
			return [aDate.getFullYear(), pad2(aDate.getMonth() + 1), pad2(aDate.getDate())].join("-");
		}
		function pad2(a) { return (a < 10)?"0" + a:a; }
		
		return (aFormat || this.mPref_name_format).split("%%").map(function(aPiece) {
			return aPiece.replace(/%(\d*)([tdm])/g, function($0, $1, $2) {
				$0 = ($2 == "t")?aTitle:($2 == "d")?toISO8601(aDate):pad2(aDate.getHours()) + ":" + pad2(aDate.getMinutes());
				return ($1)?cut($0, Math.max(parseInt($1), 3)):$0;
			});
		}).join("%");
	},

	makeFileName: function(aString)
	{
		return aString.replace(/[^\w ',;!()@&*+=~\x80-\xFE-]/g, "_").substr(0, 64) + this.mSessionExt;
	},

	getBrowserWindows: function()
	{
		var windowsEnum = this.mWindowMediator.getEnumerator("navigator:browser");
		var windows = [];
		
		while (windowsEnum.hasMoreElements())
		{
			windows.push(windowsEnum.getNext());
		}
		
		return windows;
	},

	doResumeCurrent: function(aOnce)
	{
		return (this.getPref("browser.startup.page", 1, true) == 3)?true:false;
	},

	setResumeCurrent: function(aValue)
	{
		if (aValue) this.setPref("browser.startup.page", 3, true);
		else this.setPref("browser.startup.page", this.getPref("old_startup_page", 1), true);
	},

	isCleanBrowser: function(aBrowser)
	{
		return aBrowser.sessionHistory.count < 2 && aBrowser.currentURI.spec == "about:blank";
	},

	setDisabled: function(aObj, aValue)
	{
		if (aValue)
		{
			aObj.setAttribute("disabled", "true");
		}
		else
		{
			aObj.removeAttribute("disabled");
		}
	},

	getEOL: function()
	{
		return /win|os[\/_]?2/i.test(navigator.platform)?"\r\n":/mac/i.test(navigator.platform)?"\r":"\n";
	},

	_string: function(aName)
	{
		return this.mBundle.getString(aName);
	}

};

window.addEventListener("load", gSessionManager.onLoad_proxy, false);
window.addEventListener("unload", gSessionManager.onUnload_proxy, false);

window.addEventListener("load", function() {
	if (!window.SessionManager) // if Tab Mix Plus isn't installed
	{
		window.SessionManager = gSessionManager;
	}
	if (typeof tabBarScrollStatus == "function") // hack for a Tab Mix Plus startup issue (fixed in v0.3.0.065)
	{
		setTimeout(tabBarScrollStatus, 0);
	}
}, false);
