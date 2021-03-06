// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={};

// import into the namespace
Components.utils.import("resource://sessionmanager/modules/logger.jsm", com.morac.SessionManagerAddon);
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm", com.morac.SessionManagerAddon);
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm", com.morac.SessionManagerAddon);
Components.utils.import("resource://sessionmanager/modules/session_convert.jsm", com.morac.SessionManagerAddon);

// use the namespace
with (com.morac.SessionManagerAddon) {
	var originalOverwriteLabel = null;
	var keyNames=[];
	var keysInitialized = false;
	var gLocaleKeys;
	var buttonsDisabled = false;
	var gPlatformKeys = new Object();
	
	var observer = {
		observe: function(aSubject, aTopic, aData) {
			log("options.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
			switch (aTopic)
			{
			case "sessionmanager:encryption-change":
				_("encrypt_sessions").disabled = (aData == "start");
				break;
			case "private-browsing":
				updatePrivateBrowsing();
				break;
			case "nsPref:changed":
				switch (aData)
				{
				case "extensions.tabmix.singleWindow":
					if (gPreferenceManager.get("extensions.tabmix.singleWindow", false, true)) {
						_("overwrite").label = gSessionManager._string("overwrite_tabs");
						_("open_as_tabs").style.visibility = "collapse";
					}
					else {
						_("overwrite").label = originalOverwriteLabel;
						_("open_as_tabs").style.visibility = "visible";
					}
					break;
				case "append_by_default":
					changeOverwriteLabel(_("preference.append_by_default").valueFromPreferences);
					break;
				case "use_SS_closed_window_list":
					checkClosedWindowList(_("preference.use_SS_closed_window_list").valueFromPreferences);
					break;
				case "encrypt_sessions":
					var encrypting = _("preference.encrypt_sessions").valueFromPreferences;
					_("encrypted_only").hidden = !encrypting;
					
					// When animating preferences the window can get cut off so just refresh the window size here
					if (encrypting && gPreferenceManager.get("browser.preferences.animateFadeIn", false, true))
						window.sizeToContent();
					break;
				case "logging":
					updateLogCheckboxes(_("preference.logging").valueFromPreferences);
					break;
				case "logging_level":
					readLogLevel();
					break;
				case "hide_tools_menu":
					_("show_icon_in_menu").disabled = _("preference.hide_tools_menu").valueFromPreferences;
					break;
				case "use_SQLite_cache":
					_("rebuild_cache_button").disabled = !_("preference.use_SQLite_cache").valueFromPreferences;
					break;
				}
				break;
			}
		}
	};

	var onLoad = function(aEvent) {
		this.removeEventListener("load", onLoad, false);
		this.addEventListener("unload", onUnload, false);

		// listen for encryption change start/stop and private browsing change
		OBSERVER_SERVICE.addObserver(observer, "sessionmanager:encryption-change", false);
		OBSERVER_SERVICE.addObserver(observer, "private-browsing", false);
		gPreferenceManager.observe("", observer, false);
		if (gSessionManager.tabMixPlusEnabled)
			gPreferenceManager.observe("extensions.tabmix.singleWindow", observer, false, true);

		// If instant Apply is on, hide the apply button
		if (gPreferenceManager.get("browser.preferences.instantApply", false, true)) {
			_("sessionmanagerOptions").getButton("extra1").style.visibility = "collapse";
		}
		
		// Restore selected indexes
		_("generalPrefsTab").selectedIndex = _("preference.options_selected_tab").valueFromPreferences;
		
		// Only show preserve app tabs if app tabs exists (Firefox 4.0 and up)
		if ((Application.name != "Firefox" || Application.version[0] < "4")) {
			_("preserve_app_tabs").parentNode.style.visibility = "collapse";
		}
		
		// Only show option to restore hidden tabs if default value exists for it
		if (_("browser.sessionstore.restore_hidden_tabs").defaultValue == null) {
			_("restore_hidden_tab").style.visibility = "collapse";
		}

		// Firefox 8 and up removes the concurrent tab setting and replaces it with an on demand setting
		if (_("browser.sessionstore.restore_on_demand").defaultValue != null) {
			_("concurrent_tabs").style.visibility = "collapse";
			_("restore_on_demand").style.visibility = "visible";
		}
		else {
			_("restore_on_demand").style.visibility = "collapse";
			// Only show concurrent tab setting if a default value exists for it (Firefox 4.0 and up)
			if (_("browser.sessionstore.max_concurrent_tabs").defaultValue == null) {
				_("concurrent_textbox").parentNode.style.visibility = "collapse";
			}
		}
		
		// Hide option to use built in SessionStore closed window list if not supported
		if (typeof(SessionStore.getClosedWindowCount) != "function") {
			_("closed_window_list").style.visibility = "collapse";
		}
		
		// Hide mid-click preference if Tab Mix Plus or Tab Clicking Options is enabled
		var browser = WINDOW_MEDIATOR_SERVICE.getMostRecentWindow("navigator:browser");
		if ((browser && typeof(browser.tabClicking) != "undefined") || gSessionManager.tabMixPlusEnabled) {
			_("midClickPref").style.visibility = "collapse";
		}
		
		if (gSessionManager.tabMixPlusEnabled && gPreferenceManager.get("extensions.tabmix.singleWindow", false, true)) {
			_("overwrite").label = gSessionManager._string("overwrite_tabs");
			_("open_as_tabs").style.visibility = "collapse";
		}
		
		// Disable Apply Button by default
		_("sessionmanagerOptions").getButton("extra1").disabled = true;
		
		// Disable clear undo list button if no browser window since SessionStore needs one to update the closed window list
		_("clear_undo_button").hidden = (typeof(SessionStore.forgetClosedWindow) == "undefined") && !gSessionManager.getMostRecentWindow("navigator:browser");
		
		// Disable encryption button if change in progress
		_("encrypt_sessions").disabled = gSessionManager.mEncryptionChangeInProgress;
		
		// Disable show icon in menu button if menu hidden
		_("show_icon_in_menu").disabled = _("preference.hide_tools_menu").valueFromPreferences;
		
		// Disabled enabled button based on checkbox
		_("rebuild_cache_button").disabled = !_("preference.use_SQLite_cache").valueFromPreferences;
		
		// Disable backup every text field if disabled
		_('backup_every').disabled = !_("preference.backup_every").valueFromPreferences;

		updateSpecialPreferences();
		
		adjustContentHeight();
	};
	
	var onUnload = function(aEvent) {
		this.removeEventListener("unload", onUnload, false);
		OBSERVER_SERVICE.removeObserver(observer, "sessionmanager:encryption-change");		
		OBSERVER_SERVICE.removeObserver(observer, "private-browsing");
		gPreferenceManager.unobserve("", observer);
		if (gSessionManager.tabMixPlusEnabled)
			gPreferenceManager.unobserve("extensions.tabmix.singleWindow", observer, true);
		_("preference.options_selected_tab").valueFromPreferences = _("generalPrefsTab").selectedIndex;
	};

	// Preferences that can change are here so we can update options window
	function updateSpecialPreferences(aUpdateSessionsOnly) {
		// hide/show menus for startup options
		startupSelect(_("startupOption").selectedIndex = _("preference.startup").valueFromPreferences);
	
		// Populate select session list and select previously selected session
		var resume_session = _("resume_session");
		var sessions = gSessionManager.getSessions();
		// remove any existing items
		resume_session.removeAllItems();
		resume_session.appendItem(gSessionManager._string("startup_resume"), BACKUP_SESSION_FILENAME, "");
		var maxWidth = window.getComputedStyle(_("startEndGroupbox"), null).width;
		sessions.forEach(function(aSession) {
			if ((aSession.fileName != gSessionManager.mAutoSaveSessionName) && (aSession.fileName != BACKUP_SESSION_FILENAME))
			{
				var elem = resume_session.appendItem(aSession.name, aSession.fileName, "");
				elem.setAttribute("maxwidth", maxWidth);
				elem.setAttribute("crop", "center");
			}
		}, this);
		// if no restore value, select previous browser session
		resume_session.value = _("preference.resume_session").value || BACKUP_SESSION_FILENAME;
		
		// current load session no longer there
		if (resume_session.selectedIndex == -1) {
			resume_session.value ="";
			_("preference.resume_session").valueFromPreferences = resume_session.value;
			// change option to none if select session was selected
			if (_("startupOption").selectedIndex==2) {
				startupSelect(_("startupOption").selectedIndex = 0);
				_("preference.startup").valueFromPreferences = _("startupOption").selectedIndex;
			}
		}
		
		if (!aUpdateSessionsOnly) {
			// Update displayed options based on preference
			checkClosedWindowList(_("preference.use_SS_closed_window_list").valueFromPreferences);
			
			// Change overwrite label to tabs if append to window as tab preference set
			originalOverwriteLabel = _("overwrite").label;
			changeOverwriteLabel(_("preference.append_by_default").valueFromPreferences);
		
			// Update Logging Level checkboxes
			readLogLevel();
			
			// Initialize and read keys
			initKeys()
			
			// Enable/Disable log checkboxes
			updateLogCheckboxes(_("enable_logging").checked);
			
			// Change styling if in permanent private browsing mode
			updatePrivateBrowsing();
		}
	};

	var _disable = gSessionManager.setDisabled;

	function readMaxClosedUndo(aID)
	{
		switch (aID) {
			case "max_closed":
				var value = _("preference.max_closed_undo").value;
				_disable(_("save_window_list"), value == 0);
				return value;
				break;
			case "max_closed_SS":
				var value = _("browser.sessionstore.max_windows_undo").value;
				_disable(_("save_closed_windows"), value == 0);
				_disable(document.getElementsByAttribute("control", "save_closed_windows")[0], value == 0);
				return value;
				break;
		}
		
		return 0;
	}

	function readMaxTabsUndo()
	{
		var value = _("browser.sessionstore.max_tabs_undo").value;
		
		_disable(_("save_closed_tabs"), value == 0);
		_disable(document.getElementsByAttribute("control", "save_closed_tabs")[0], value == 0);
		
		return value;
	}

	function promptClearUndoList(aType)
	{
		var max_tabs_undo = _("max_tabs").value;
		
		gSessionManager.clearUndoListPrompt(aType);
		
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

	function logLevelUpdate() {
		// If instant apply on, apply immediately
		if (gPreferenceManager.get("browser.preferences.instantApply", false, true)) {
			setLogLevel();
		}
		else enableApply();
	}

	function setLogLevel() {
		var logLevel = 0;
		var logCB = document.getElementsByAttribute("class", "logLevel");
		for (var i=0; i < logCB.length; i++) {
			logLevel = logLevel | (logCB[i].checked ? logging_level[logCB[i].getAttribute("_logLevel")] : 0);
		};
		
		_("preference.logging_level").valueFromPreferences = logLevel;
	}

	function readLogLevel() {
		var logLevel = _("preference.logging_level").valueFromPreferences;
		var logCB = document.getElementsByAttribute("class", "logLevel");
		for (var i=0; i < logCB.length; i++) {
			logCB[i].checked = ((logLevel & logging_level[logCB[i].getAttribute("_logLevel")]) > 0);
		};
	}
	
	function updateLogCheckboxes(checked) {
		var boxes = _("loggingCategories").getElementsByTagName("checkbox");
		for (var i = 0; i < boxes.length; i++) {   
			boxes[i].disabled = !checked;
		}
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
			_("preference.sessions_dir").value = filepicker.file.path;
		}
	} 	 

	function defaultSessionDir() {
		_("preference.sessions_dir").value = '';
	}

	function checkEncryption(aState) {
		try {
			// force a master password prompt so we don't waste time if user cancels it
			SECRET_DECODER_RING_SERVICE.encryptString("");
		}
		catch (ex) {
			gSessionManager.cryptError(gSessionManager._string("change_encryption_fail"));
			return !aState;
		}
		_("encrypted_only").hidden = !aState;
		
		// When animating preferences the window can get cut off so just refresh the window size here
		if (aState && gPreferenceManager.get("browser.preferences.animateFadeIn", false, true))
			window.sizeToContent();
		
		return aState;
	}

	function checkEncryptOnly(aState) {
		if (aState && !_("preference.encrypted_only").valueFromPreferences) {
			if (!PROMPT_SERVICE.confirm(window, gSessionManager.mTitle, gSessionManager._string("encrypt_only_confirm"))) {
				aState = false;
			}
		}
		
		return aState;
	}

	function changeOverwriteLabel(aChecked) {
		_("overwrite").label = aChecked ? gSessionManager._string("overwrite_tabs") : originalOverwriteLabel;
	}

	function checkClosedWindowList(aChecked) {
		// Hide the option to not clear the list of closed windows on shutdown if we are using the built in closed windows
		var builtin = aChecked && (_("closed_window_list").style.visibility != "collapse");
		
		_("save_window_list").style.visibility = builtin ? "collapse" : "visible";
		_("max_closed").style.visibility = builtin ? "collapse" : "visible";
		_("max_closed_SS").style.visibility = builtin ? "visible" : "collapse";
		_("closed_windows_menu").style.visibility = builtin ? "visible" : "collapse";
	}

	function startupSelect(index) {
		// hide/display corresponding menus	
		_("browserStartupPage").style.visibility = (index != 0)?"collapse":"visible";
		_("preselect").style.visibility = (index != 1)?"collapse":"visible";
		_("resume_session").style.visibility = (index != 2)?"collapse":"visible";
		//if (index == 1) _("resume_session").style.visibility = "hidden";
		
		// If instant apply on, apply immediately
		if (gPreferenceManager.get("browser.preferences.instantApply", false, true)) {
			setStartValue();
		}
	}

	function setStartValue() {
		_("preference.startup").valueFromPreferences = _("startupOption").selectedIndex;
	}

	function savePrefs() {
		var prefs = document.getElementsByTagName('preference');
		for (var i=0; i<prefs.length; i++) {
			prefs[i].valueFromPreferences = prefs[i].value;
		}
		saveSpecialPrefs();
		
		// Disable Apply Button
		_("sessionmanagerOptions").getButton("extra1").disabled = true;
	}	
	
	function saveSpecialPrefs() {
		setStartValue();
		setLogLevel();
		saveKeyConfig();
	}

	function enableApply() {
		_("sessionmanagerOptions").getButton("extra1").disabled = false;
	}

	function disableApply() {
		_("sessionmanagerOptions").getButton("extra1").disabled = true;
	}
	
	function goHelp() {
		var link = "http://sessionmanager.mozdev.org/options.html#";
		
		switch (_("sessionmanagerOptions").currentPane) {
			case (_("mainPrefPane")):
				switch (_("generalPrefsTab").selectedIndex) {
					case 0:
						link = link + "startup";
						break;
					case 1:
						link = link + "saving";
						break;
					case 2:
						link = link + "display";
						break;
					case 3:
						link = link + "keyboard";
						break;
				}
				break;
			case (_("undoclosePrefPane")):
				link = link + "undo";
				break;
			case (_("advancedPrefPane")):
				link = link + "advanced";
				break;
			case (_("sessionstorePrefPane")):
				link = link + "sessionstore";
				break;
			case (_("loggingPrefPane")):
				link = link + "logging";
				break;
		}
		
		openLink(link);
	}

	function openLink(url) {
		var top = Components.classes["@mozilla.org/appshell/window-mediator;1"]
				 .getService(Components.interfaces.nsIWindowMediator).getMostRecentWindow("navigator:browser");
						 
		if (!top) window.open(url, "", "");
		else {
			var tBrowser = top.getBrowser();
			var currBlank = false;
				
			// Is current tab blank or already on help page.
			if (tBrowser && tBrowser.mCurrentTab.linkedBrowser) {
				var location = tBrowser.mCurrentTab.linkedBrowser.contentDocument.location.href;
				var index = location.indexOf("#");
				var baseLocation = (index == -1)? location : location.substring(0,index);
				index = url.indexOf("#");
				var baseURL = (index == -1)? url : url.substring(0,index);
				currBlank = (location == "about:blank") || (baseLocation == baseURL);
			}
									   
			if (currBlank) tBrowser.loadURI(url);
			else {
				var tab = tBrowser.addTab(url);
				tBrowser.selectedTab = tab;
			}
		}
	}

	function adjustContentHeight() {
		// Localize strings aren't used when the initial height is used to calculate the size of the context-box
		// and preference window.  The height is calculated correctly once the window is drawn, but the context-box
		// and preference window heights are never updated.
		// To fix this, we need to explicitly set the height style of any element with a localized string that is more 
		// than one line (the descriptions).  This will correct the heights when the panes are selected.
		var largestNewPaneHeight = 0;
		var largestCurrentPaneHeight = 0;
		var biggestPane = null;
		for (var i=0; i < _("sessionmanagerOptions").preferencePanes.length; i++) {
			var pane = _("sessionmanagerOptions").preferencePanes[i];
			var descriptions = pane.getElementsByTagName('description');
			var adjustHeight = 0;
			for (var j=0; j<descriptions.length; j++) {
				var height = window.getComputedStyle(descriptions[j], null).height;
				if (height != "auto") {
					descriptions[j].style.height = height;
					adjustHeight += parseInt(height) - 26;
				}
			}
			adjustHeight = pane.contentHeight + adjustHeight;
			if (adjustHeight > largestNewPaneHeight) {
				largestNewPaneHeight = adjustHeight;
				biggestPane = pane;
			}
			if (pane.contentHeight > largestCurrentPaneHeight) 
				largestCurrentPaneHeight = pane.contentHeight;
		}
		// The exception to this is if the largest pane is already selected when the preference window is opened.  In
		// this case the window inner height must be correct as well as the context-box height (if animation is disabled).
		var currentPane = _("sessionmanagerOptions").currentPane;
		var animate = gPreferenceManager.get("browser.preferences.animateFadeIn", false, true);

		// When not animating, the largest pane's content height is not correct when it is opened first so update it.
		// Also the window needs to be resized to take into account the changes to the description height.
		if (!animate) {
			// For some reason if opening the largest (Advanced) pane first and the encrypt only box is checked, the size is wrong so tweak it.
			if ((currentPane == biggestPane) && !_("encrypted_only").hidden) largestNewPaneHeight += 12;
			biggestPane._content.height = largestNewPaneHeight;
			window.sizeToContent();
		}
		// When animating the window needs to be resized to take into account the changes to the description height and
		// then shrunk since the opening pane is sized to the largest pane height which is wrong.
		else {
			// Hide/show the encrypt only check box here when opening the largest pane to prevent window looking to large.
			if (currentPane == biggestPane) {
				_("encrypted_only").hidden = !_("encrypt_sessions").checked;
			}
		
			window.sizeToContent();
			// If encrypted only checkbox is hidden need to tweak the height
			var adjuster = (_("encrypted_only").hidden) ? (2 * largestCurrentPaneHeight - largestNewPaneHeight) : largestCurrentPaneHeight;
			window.innerHeight -= adjuster - currentPane.contentHeight;
		}
		
		// Hide/show the encrypt only checkbox based on state of encryption checkbox
		_("encrypted_only").hidden = !_("encrypt_sessions").checked;
		
		// Re-select same pane to refresh it - General pane's tab boxes aren't the right height unless the General tab is re-selected
		_("sessionmanagerOptions")._selector.selectedItem.click();
	}
	
	// Key stuff - originally comes from keyconfig add-on
	function initKeys() {
		if (!keysInitialized) {
			for (var property in KeyEvent) {
				keyNames[KeyEvent[property]] = property.replace("DOM_","");
			}
			keyNames[8] = "VK_BACK";

			gLocaleKeys = document.getElementById("localeKeys");

			var platformKeys = document.getElementById("platformKeys");
			gPlatformKeys.shift = platformKeys.getString("VK_SHIFT");
			gPlatformKeys.meta  = platformKeys.getString("VK_META");
			gPlatformKeys.alt   = platformKeys.getString("VK_ALT");
			gPlatformKeys.ctrl  = platformKeys.getString("VK_CONTROL");
			gPlatformKeys.sep   = platformKeys.getString("MODIFIER_SEPARATOR");
			switch (gPreferenceManager.get("ui.key.accelKey", 0, true)){
				case 17:  gPlatformKeys.accel = gPlatformKeys.ctrl; break;
				case 18:  gPlatformKeys.accel = gPlatformKeys.alt; break;
				case 224: gPlatformKeys.accel = gPlatformKeys.meta; break;
				default:  gPlatformKeys.accel = (window.navigator.platform.search("Mac") == 0 ? gPlatformKeys.meta : gPlatformKeys.ctrl);
			}
			keysInitialized = true;
		}
		
		readKeyConfig();
	}
	
	function clearKey(element) {
		element.previousSibling.value = "";
		element.previousSibling.key = "";
		
		if (gPreferenceManager.get("browser.preferences.instantApply", false, true)) {
			saveKeyConfig();
		}
		else enableApply();
	}
	
	function readKeyConfig() {
		var keys = gSessionManager.JSON_decode(_("preference.keys").valueFromPreferences, true);
		if (!keys._JSON_decode_failed) {
		
			var keyBoxes = _("key_rows").getElementsByTagName("textbox");
			for (var i=0; i < keyBoxes.length; i++) {
				var keyname = keyBoxes[i].id.replace(/_key/,"");
				keyBoxes[i].value = (keys[keyname]) ? getFormattedKey(keys[keyname].modifiers,keys[keyname].key,keys[keyname].keycode) : "";
				keyBoxes[i].key = keys[keyname];
			}
		}
	}
	
	function saveKeyConfig() {
		var keys = {};
		
		var keyBoxes = _("key_rows").getElementsByTagName("textbox");
		for (var i=0; i < keyBoxes.length; i++) {
			if (keyBoxes[i].key) {
				keys[keyBoxes[i].id.replace(/_key/,"")] = keyBoxes[i].key;
			}
		}
		
		_("preference.keys").valueFromPreferences = gSessionManager.JSON_encode(keys);
	}
	
	function getFormattedKey(modifiers,key,keycode) {
		if(modifiers == "shift,alt,control,accel" && keycode == "VK_SCROLL_LOCK") return "";
		if(key == "" || (!key && keycode == "")) return "";

		var val = "";
		if(modifiers) val = modifiers
			.replace(/^[\s,]+|[\s,]+$/g,"").split(/[\s,]+/g).join(gPlatformKeys.sep)
			.replace("alt",gPlatformKeys.alt)
			.replace("shift",gPlatformKeys.shift)
			.replace("control",gPlatformKeys.ctrl)
			.replace("meta",gPlatformKeys.meta)
			.replace("accel",gPlatformKeys.accel)
			+gPlatformKeys.sep;
		if(key)
			val += key;
		if(keycode) try {
			val += gLocaleKeys.getString(keycode)
		} catch(e){val += gStrings.unrecognized.replace("$1",keycode);}

		return val;
	}
	
	function keyPress(element, event) {
		var modifiers = [];
		if(event.altKey) modifiers.push("alt");
		if(event.ctrlKey) modifiers.push("control");
		if(event.metaKey) modifiers.push("meta");
		if(event.shiftKey) modifiers.push("shift");

		// prevent key commands without a modifier or with only 1 modifier, but not CTRL
		if ((modifiers.length == 0) || ((modifiers.length == 1) && (modifiers[0] != "control"))) {
			// Allow tab, shift-tab, escape, enter/return and F1 (help)
			if ((event.keyCode != KeyEvent.DOM_VK_TAB) && (event.keyCode != KeyEvent.DOM_VK_ESCAPE) && 
			    (event.keyCode != KeyEvent.DOM_VK_RETURN)  && (event.keyCode != KeyEvent.DOM_VK_ENTER) && (event.keyCode != KeyEvent.DOM_VK_F1)) {
				event.preventDefault();
				event.stopPropagation(); 
				
				// clear on delete or backspace
				if ((event.keyCode == KeyEvent.DOM_VK_BACK_SPACE) ||  (event.keyCode == KeyEvent.DOM_VK_DELETE))
					clearKey(element.nextSibling);
			}
		
			return;
		}

		event.preventDefault();
		event.stopPropagation(); 
			
		modifiers = modifiers.join(" ");

		var key = null; var keycode = null;
		if (event.charCode) key = String.fromCharCode(event.charCode).toUpperCase();
		else { keycode = keyNames[event.keyCode]; if(!keycode) return;}

		var keyvalue = getFormattedKey(modifiers,key,keycode);
		
		// check if duplicate key
		var keyBoxes = _("key_rows").getElementsByTagName("textbox");
		for (var i=0; i < keyBoxes.length; i++) {
			if (keyBoxes[i].value == keyvalue) return;
		}
		
		element.value = getFormattedKey(modifiers,key,keycode);
		element.key = { modifiers: modifiers, key: key, keycode: keycode };
		
		if (gPreferenceManager.get("browser.preferences.instantApply", false, true)) {
			saveKeyConfig();
		}
		else enableApply();
	}
	
	// Disable buttons and labels to prevent accesskey from kicking off when ALT is pressed.
	// Only start disabling if ALT pressed, but keep disabling until keys released.
	function disableButtons(aEvent) {
		var disable = (aEvent.type == "keydown") && (aEvent.keyCode == KeyEvent.DOM_VK_ALT);
		var enable = (aEvent.type == "keyup");
		
		var buttons = _("sessionmanagerOptions").getElementsByTagName("button");
		var labels = _("key_rows").getElementsByTagName("label");
		
		if (disable && !buttonsDisabled) {
			buttonsDisabled = true;
			for (var i=0; i < buttons.length; i++) buttons[i].disabled = true;
			_("sessionmanagerOptions").getButton("help").disabled = true;
			for (var i=0; i < labels.length; i++) {
				// save old attribute
				labels[i].setAttribute("saved_accesskey", labels[i].getAttribute("accesskey"));
				labels[i].removeAttribute("accesskey");
			}
		}
		else if (enable && buttonsDisabled) {
			buttonsDisabled = false;
			for (var i=0; i < buttons.length; i++) buttons[i].disabled = false;
			_("sessionmanagerOptions").getButton("help").disabled = false;
			for (var i=0; i < labels.length; i++) {
				// save old attribute
				labels[i].setAttribute("accesskey", labels[i].getAttribute("saved_accesskey"));
				labels[i].removeAttribute("saved_accesskey");
			}
		}
	}
	
	function updatePrivateBrowsing() {
		checkPrivateBrowsing(_("backup_session"));
		checkPrivateBrowsing(_("resume_session"));
	}
	
	function checkPrivateBrowsing(aElem) {
		var warn = (aElem.id == "backup_session" && (aElem.value != 0)) || ((aElem.id == "resume_session") && (aElem.value == BACKUP_SESSION_FILENAME));

		if (warn && gSessionManager.isAutoStartPrivateBrowserMode()) {
			aElem.setAttribute("warn", "true");
			aElem.setAttribute("tooltiptext", gSessionManager._string("private_browsing_warning"));
		}
		else {
			aElem.removeAttribute("warn");
			aElem.removeAttribute("tooltiptext");
		}
	}
	
	// Disable periodic backup if time specified is invalid
	function checkBackupTime(time) {
		if (!(parseInt(time) > 0)) {
			_("backup_every_cb").checked = false;
			_("preference.backup_every").value = false;
			_("backup_every").value = 0;
			_("preference.backup_every_time").value = 0;
			_("backup_every").disabled = true;
		}
	}
}
window.addEventListener("load", onLoad, false);
