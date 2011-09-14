// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};
if(!com.morac.SessionManagerAddon) com.morac.SessionManagerAddon={};

Components.utils.import("resource://sessionmanager/modules/logger.jsm");
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");

// use the namespace
with (com.morac.SessionManagerAddon) {
	com.morac.SessionManagerAddon.gSessionManagerSessionPrompt = {

		gParams: null,
		gSessionTree: null,
		gSearchTextBox: null,
		gTextBox: null,
		gTextBoxVisible: false,
		ggMenuList: null,
		ggMenuListVisible: false,
		gTabTree: null,
		gTabTreeBox: null,
		gTreeSplitter: null,
		gCtrlClickNote: null,
		gAcceptButton: null,
		gExtraButton: null,
		gExistingSessionNames: {},
		gSessionNames: {},
		gGroupNames: [],
		gBackupGroupName: null,
		gBannedNames: [],
		gBackupNames: [],
		gBannedFileNames: [],
		gSessionTreeData: null,
		gOriginalSessionTreeData: null,
		// gExistingName is the index of the item with the name in the text field.  -1 means no match
		gExistingName: -1,
		gNeedSelection: false,
		gInvalidTime: false,
		gFinishedLoading: false,
		gReDrawWindow: true,
		gReadSQLCache: 0,
		
		gLastSearchText: "",
		
		// searching shortcuts
		gSearchTitle: gPreferenceManager.get("browser.urlbar.match.title", "#", true),
		gSearchURL: gPreferenceManager.get("browser.urlbar.match.url", "@", true),
		gSearchName: gPreferenceManager.get("browser.urlbar.match.bookmark", "*", true),
		gSearchGroup: gPreferenceManager.get("browser.urlbar.match.tag", "+", true),
		gSearchHistroy: gPreferenceManager.get("browser.urlbar.match.history", "^", true),
		
		// For saving last selected row so it can be restored
		gLastSelectedRow: null,
		
		// Used to adjust height of window when unchecking "auto save" box
		gSavedEveryHeight: 0,
		
		// Flag used to indicate if select tree should do anything
		gSelectSessionTreeActive: false,

		// Used to keep track of the accept button position change
		gAcceptPositionDifference: 0,
		gLastScreenY: 0,
		gTimerId: null,
		
		// Is this a modal window?
		modal: false,

		sortedBy: { column: null, direction: 0 },
		
		// search variables
		gSearchTimer: null,
		gSearching: false,
		getSessionsSearchOverride: null,
		gSessionCache: null,

		// Input parameters stored in gSessionManager.sessionPromptData:
		// acceptExistingLabel  - Okay button label when overwriting existing session
		// acceptLabel          - Okay Button label for normal accept
		// addCurrentSession    - True when recovering from crash
		// allowNamedReplace    - True if double clicking a session name on save will replace existing session, but use default session name.
		// append_replace       - True if displaying the append/replace radio group, false otherwise
		// autoSaveable         - Displays autosave checkbox if true
		// callbackData         - Data to pass back to the gSessionManager.sessionPromptCallBack function.  Window will be modal if not set
		// crashCount           - Count String for current crashed session
		// defaultSessionName   - Default value comes from page title
		// filename             - Filename of session save file
		// getSessionsOverride  - Function to call to retrieve session list instead of gSessionManager.getSessions()
		// grouping             - True if changing grouping
		// ignorable            - Displays ignore checkbox if true
		// multiSelect          - True if allowed to choose multiple sessions (used for deleting)
		// preselect            - True if preselecting last backup session
		// remove               - True if deleting session(s)
		// selectAll            - True if all multiple items should be selected on initial prompt, false otherwise
		// sessionLabel         - Label at top of window
		// startupPrompt        - True if displayed when browser is first starting up, but not recovering from crash
		// textLabel            - Label above text box
		// modal                - True if window is modal (when there's no callbackData, saving a window or first window prompt (crash or normal))
		// startup              - True if prompting for startup (crash or normal)

		// Output parameters, stored in gSessionManager.sessionPromptReturnData
		// append               - True if append session, false if not
		// append_window        - True if append to window, false if not
		// autoSave             - True if autosave button pressed
		// autoSaveTime         - Auto save time value
		// filename             - Filename(s) - If multiple filenames returned, returned as "\n" separated string.
		// groupName            - Group Name
		// ignore               - True if ignore checkbox checked
		// sessionName          - Session Name
		// sessionState         - Session state when not all tabs are selected
		
		// SetInt 0 bit values
		// 1 = Accept or Extra1 button pressed

		// Used to disable saving if user switches to private browsing mode.
		observe: function(aSubject, aTopic, aData)
		{
			log("session_prompt.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
			switch (aTopic)
			{
			case "private-browsing":
				this.checkPrivateBrowsingMode(aData == "enter", this.gParams.autoSaveable);
				break;
			case "sessionmanager:update-session-tree":
				this.updateWindow();
				break;
			case "sessionmanager:sql-cache-updated":
				gSQLManager.readSessionDataFromSQLCache(this.sessionCacheCallback);
				break;
			case "nsPref:changed":
				if (aData == "extensions.tabmix.singleWindow") {
					if (gPreferenceManager.get("extensions.tabmix.singleWindow", false, true)) {
						if (!this._("radio_append_replace").selectedIndex) this._("radio_append_replace").selectedIndex = 2;
						this._("radio_append").hidden = true;
					}
					else {
						if (this._("radio_append_replace").selectedIndex == 2 &&  !gPreferenceManager.get("overwrite", false) && !gPreferenceManager.get("append_by_default", false))
							this._("radio_append_replace").selectedIndex = 0;
						this._("radio_append").hidden = false;
					}
				}
				break;
			}
		},

		persist: function(aObj, aAttr, aValue)
		{
			aObj.setAttribute(aAttr, aValue);
			document.persist(aObj.id, aAttr);
		},
		
		leaveWindowOpenChange: function(aChecked) {
			// save leave_window_open preference.
			let pref = gPreferenceManager.get("leave_prompt_window_open","").split(",");
			let index = pref.indexOf(this._("actionButton").label);
			if (aChecked != (index != -1)) {
				if (aChecked)
					pref.push(this._("actionButton").label)
				else
					pref.splice(index, 1);
				gPreferenceManager.set("leave_prompt_window_open", pref.toString().replace(/^,/,""));
			}
		},

		onLoad: function() {
			OBSERVER_SERVICE.addObserver(this, "private-browsing", false);
			OBSERVER_SERVICE.addObserver(this, "sessionmanager:update-session-tree", false);
			OBSERVER_SERVICE.addObserver(this, "sessionmanager:sql-cache-updated", false);
			if (gSessionManager.tabMixPlusEnabled)
				gPreferenceManager.observe("extensions.tabmix.singleWindow", this, false, true);

			// Set "accept" value to false for modal windows
			window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock).SetInt(0, 0);
			
			// Window is modal if no callback data or if first window opened (crash or restore prompt)
			this.modal = gSessionManager.sessionPromptData.modal;
			
			// Remove windowtype from modal windows to prevent them from being re-used
			if (this.modal && !gSessionManager.sessionPromptData.startup) {
				this._("sessionmanagerPrompt").removeAttribute("windowtype");
			}
			
			this._("mac_title").hidden = !/mac/i.test(navigator.platform);
			
			this.gAcceptButton = document.documentElement.getButton("accept");
			this.gExtraButton = document.documentElement.getButton("extra1");

			// Store XUL references
			this.gSearchTextBox = this._("search");
			this.gTextBox = this._("text_box");
			this.ggMenuList = this._("group_menu_list");
			this.gTabTree = this._("tabTree");
			this.gTabTreeBox = this._("tabTreeBox");
			this.gTreeSplitter = this._("tree_splitter");
			this.gCtrlClickNote = this._("ctrl_click_note");
			this.gSessionTree = this._("session_tree");
			
			// Store "Constants"
			this.gBackupGroupName = gSessionManager._string("backup_sessions");

			// Disable saving in privacy mode
			this.checkPrivateBrowsingMode(gSessionManager.isPrivateBrowserMode(), gSessionManager.sessionPromptData.autoSaveable, true);
			
			// Show selection menu if window is not modal
			if (!this.modal) this._("menuBox").hidden = false;
			
			// Display the window
			this.drawWindow();

			// Need to remove "rows" attribute from session tree otherwise it jumps around when selecting. 
			// Need to do the same thing for tab tree otherwise Firefox 3.6 and higher will constantly repaint
			// the window if the tab tree's height is 128 or more.  This causes high CPU usage and is likely a bug.
			// We still need it to display 5 rows by default so set minimum height persistence to prevent height from shrinking to 0.
			
			// Persist minheights if not already done - use session tree's height for tab trees since 
			// they both contain 5 rows and will have the same minheight.
			if (!this.gTabTree.hasAttribute("minheight")) {
				this.persist(this.gSessionTree, "minheight", this.gSessionTree.treeBoxObject.height);
				this.persist(this.gTabTree, "minheight", this.gSessionTree.treeBoxObject.height);
			}
			
			// Remove session tree row - tab tree was removed from xul.
			this.gSessionTree.removeAttribute("rows");
			
			// Restore session tree height if stored
			if (this.gSessionTree.hasAttribute("height"))
			{
				this.gSessionTree.height = this.gSessionTree.getAttribute("height");
			}
			
			if (!window.opener || this.modal)
			{
				document.title += " - " + document.getElementById("bundle_brand").getString("brandFullName");
				document.documentElement.removeAttribute("screenX");
				document.documentElement.removeAttribute("screenY");
			}
			
			window.sizeToContent();
			// Adjust window so it's not offscreen
			this.adjustWindowSizeAndPosition();
			
			this.gFinishedLoading = true;
		},

		onUnload: function() {
			this.gSelectSessionTreeActive = false;
			OBSERVER_SERVICE.removeObserver(this, "private-browsing");
			OBSERVER_SERVICE.removeObserver(this, "sessionmanager:update-session-tree");
			OBSERVER_SERVICE.removeObserver(this, "sessionmanager:sql-cache-updated");
			if (gSessionManager.tabMixPlusEnabled)
				gPreferenceManager.unobserve("extensions.tabmix.singleWindow", this, true);

			// Clear any currently stored functions
			if (this.gParams) {
				delete this.gParams.getSessionsOverride;
			}
			
			// Cleanup saved window if it exists
			gSessionManagerSessionBrowser.oneWindow = null;

			// if windows are watching for page loads and tab moves tell them to stop
			if (gSessionManager.savingTabTreeVisible) {
				gSessionManager.savingTabTreeVisible = false;
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:save-tab-tree-change", "close");
			}
			
			if (window.opener && !this.modal)
			{
				this.persist(document.documentElement, "screenX", window.screenX);
				this.persist(document.documentElement, "screenY", window.screenY);
			}
			
			this.persistTreeHeights();
			
			// In Firefox 4 and up copy "hidden" attribute for tab group items to "_hidden" for persisting.  We can't persist "hidden" 
			// since that's explicitly set to true for Firefox 3.6 and lower. Do this here so we don't need to use a DOM Mutation event
			// which is not allowed.
			if ((Application.name.toUpperCase() == "FIREFOX") && (VERSION_COMPARE_SERVICE.compare(Application.version, "4.0b4pre") >= 0)) {
				var tabgroup = document.getElementById("tabgroup");
				var hidden = document.getElementById("hidden");
				hidden.setAttribute("_hidden", hidden.getAttribute("hidden"));
				tabgroup.setAttribute("_hidden", tabgroup.getAttribute("hidden"));
			}
			
			// The following line keeps the window width from increasing when sizeToContent is called.
			this._("sessionmanagerPrompt").width = window.innerWidth - 1;
			
			// Handle case if user closes window without click Okay.  Only used for modal windows, specifically
			// startup session prompt.  Object is initialized in session_manager.jsm because initializing it here
			// would result in a memory leak for non-modal windows, where gSessionManager.sessionPromptReturnData isn't cleared out
			// on return.
			if (gSessionManager.sessionPromptReturnData) gSessionManager.sessionPromptReturnData.ignore = this._("checkbox_ignore").checked;
			
			log("Session Manager window done unloading", "INFO");
		},

		// Draw the window using parameters from gSessionManager.sessionPromptData
		drawWindow: function() {
			
			// Clear any currently stored functions
			if (this.gParams) {
				delete this.gParams.getSessionsOverride;
			}
			
			// store input parameters and 
			this.gParams = {
				// strings
				acceptExistingLabel: gSessionManager.sessionPromptData.acceptExistingLabel,
				acceptLabel: gSessionManager.sessionPromptData.acceptLabel,
				callbackData: gSessionManager.sessionPromptData.callbackData,
				crashCount: gSessionManager.sessionPromptData.crashCount,
				defaultSessionName: gSessionManager.sessionPromptData.defaultSessionName,
				filename: gSessionManager.sessionPromptData.filename,
				sessionLabel: gSessionManager.sessionPromptData.sessionLabel,
				textLabel: gSessionManager.sessionPromptData.textLabel,
				// booleans
				addCurrentSession: gSessionManager.sessionPromptData.addCurrentSession,
				allowNamedReplace: gSessionManager.sessionPromptData.allowNamedReplace,
				append_replace: gSessionManager.sessionPromptData.append_replace,
				autoSaveable: gSessionManager.sessionPromptData.autoSaveable,
				grouping: gSessionManager.sessionPromptData.grouping,
				ignorable: gSessionManager.sessionPromptData.ignorable,
				multiSelect: gSessionManager.sessionPromptData.multiSelect,
				preselect: gSessionManager.sessionPromptData.preselect,
				remove: gSessionManager.sessionPromptData.remove,
				selectAll: gSessionManager.sessionPromptData.selectAll,
				startupPrompt: gSessionManager.sessionPromptData.startupPrompt,
				// override function
				getSessionsOverride: gSessionManager.sessionPromptData.getSessionsOverride
			};
			
			let save_to_save = false;
			// Update selection menu if not modal
			if (!this.modal) {
				let label = null;
				let save = false;
				// Remove private attribute if changing since can't change to save when in private browsing
				this._("actionButton").removeAttribute("private");
				switch(this.gParams.callbackData.type) {
					case "save":
						save = true;
						label = this.gParams.callbackData.oneWindow ? this._("saveWin").label : this._("save").label;
						break;
					case "load": 
						label = this._("load").label;
						break;
					case "rename":
						label = this._("rename").label;
						break;
					case "group":
						label = this._("group-menu").label;
						break;
					case "delete":
						label = this._("remove").label;
						break;
				}
				let saving_window = (this._("actionButton").label == this._("saveWin").label);
				// If save window changing to save window
				if (save && (saving_window || (this._("actionButton").label == this._("save").label))) {
					save_to_save = true;
				}
				// don't update window if same command used except for saving current window
				if (!saving_window && (this._("actionButton").label == label)) {
					// update session name if saving
					if (this.gParams.defaultSessionName) {
						this.ggMenuList.value = "";
						this.gTextBox.value = "";
						this.populateDefaultSessionName(this.gParams.defaultSessionName);
					}
					return;
				}
				this._("actionButton").label = label;
			}
			
			// Check/uncheck leave window open checkbox based on preference
			this._("leave_window_open").checked = (gPreferenceManager.get("leave_prompt_window_open","").split(",").indexOf(this._("actionButton").label) != -1);
			
			// Clear any passed functions and parameters from global variable to prevent leaking
			delete gSessionManager.sessionPromptData.getSessionsOverride;
			gSessionManager.sessionPromptData = null;

			this.gAcceptButton.label = this.gParams.acceptLabel || this.gAcceptButton.label;
			this.gSessionTree.selType = (this.gParams.multiSelect)?"multiple":"single";

			var currentSessionTreeHeight = this.gSessionTree.treeBoxObject.height;
			
			// clear the text boxes here since for some reason in Firefox 4, they won't clear when set to "" in updateWindow 
			// when called from drawWindow (bug in FF4 having to do something with hidden textboxes, but I can't create a simple test case)
			this.ggMenuList.value = "";
			this.gTextBox.value = "";
			
			// if not initial window load
			if (this.gFinishedLoading) {
				// hide text boxes
				this.gTextBoxVisible = !(this._("group-text-container").hidden = true);
				this.ggMenuListVisible = !(this._("session-text-container").hidden = true);

				// hide tab tree if not saving
				if (!this.gParams.autoSaveable) this.gTabTreeBox.hidden = this.gTreeSplitter.hidden = true;
				this.gSelectSessionTreeActive = false;
				
				// Save current session and tab tree heights
				this.persistTreeHeights();
				
				// Hide and disable extra button
				this.gExtraButton.disabled = this.gExtraButton.hidden = true;
			}
			
			this.gReDrawWindow = true;
			this.updateWindow();
			this.gReDrawWindow = false;
			
			// Display Tab Tree if saving session otherwise adjust height if not initial load
			if (this.gParams.autoSaveable) {
				this.displayTabTree(save_to_save);
			}
			else if (this.gFinishedLoading) {
				// Fix session tree height to prevent it from changing
				this.adjustSessionTreeHeight(currentSessionTreeHeight);
			}
			
			// If Saving and wasn't previously saving, notify windows to listen for tab moves and page loads
			// If not saving and was previously, notify windows to not listen for tab moves and page loads
			var wasTabTreeVisible = gSessionManager.savingTabTreeVisible;
			gSessionManager.savingTabTreeVisible = this.gParams.autoSaveable;

			// If status changed, notifiy windows
			if (wasTabTreeVisible != gSessionManager.savingTabTreeVisible) {
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:save-tab-tree-change", gSessionManager.savingTabTreeVisible ? "open" : "close");
			}
		},

		// Update window without re-reading parameters
		updateWindow: function(aSelectedFileName) {
			var oldSessionTreeRowCount = 0;
		
			// If already loaded
			if (this.gFinishedLoading) {
				
				// Get current row count
				oldSessionTreeRowCount = this.sessionTreeView.rowCount;
				
				// Reset variables
				this.gExistingSessionNames = {};
				this.gSessionNames = {};
				this.gGroupNames = [];
				this.gBannedNames = [];
				this.gBannedFileNames = [];
				this.gBackupNames = [];
				this.gExistingName = -1;
				this.gInvalidTime = false;
				
				// Remove old descriptions
				this.removeDescriptions();

				// If not called from searching function
				if (!aSelectedFileName) {
					// unselect any selected session
					this.gSessionTree.view.selection.clearSelection();
					this.gLastSelectedRow = null;

					// clean up text boxes
					this.ggMenuList.removeAllItems();
					this.ggMenuList.value = "";
					this.gTextBox.value = "";
					this.onTextboxInput();
				
					// make sure session tree is not disabled
					this.gSessionTree.disabled = false;
					
					if (!this.gReDrawWindow) {
						// remove any preentered filename or preselected name
						this.gParams.filename = "";
						this.gParams.defaultSessionName = "";
					}
				}
			}

			this.setDescription(this._("session_label"), this.gParams.sessionLabel);
			
			// Get all sessions by default
			var sessions = gSessionManager.getSessions();
			var groupCount = 0;
			
			// save database for all sessions in case we try to save over an existing session
			sessions.forEach(function(aSession) {
				var trimName = aSession.name.trim().toLowerCase();
				this.gExistingSessionNames[trimName] = { group: aSession.group, autosave: false, autosave_time: 0 };
				// Break out Autosave variables
				if (aSession.autosave) {
					var autosave = aSession.autosave.split("/");
					this.gExistingSessionNames[trimName].autosave = autosave[0];
					this.gExistingSessionNames[trimName].autosave_time = autosave[1];
				}
				
				// Build group menu list
				if (aSession.group && !aSession.backup) {
					// Don't treat special chars in group as regular expression characters
					let groupRegExp = aSession.group.replace(/([\(\)\[\]\^\$\*\+\|\.\\\/])/g,"\\$1");
					let regExp = new RegExp("^" + groupRegExp + "|," + groupRegExp + "$|," + groupRegExp + ",");
					if (!regExp.test(this.gGroupNames.toString())) {
						this.gGroupNames[groupCount++] = aSession.group.trim();
					}
				}
			}, this);
			
			// Get override or search session list if there are any
			if (this.getSessionsSearchOverride && (typeof this.getSessionsSearchOverride == "function")) {
					try {
						sessions = this.getSessionsSearchOverride();
					} catch (ex) { 
						logError(ex); 
					}
			}
			else if (this.gParams.getSessionsOverride) {
				if (typeof this.gParams.getSessionsOverride == "function") {
					try {
						sessions = this.gParams.getSessionsOverride();
					} catch (ex) { 
						log("Override function error. " + ex, "ERROR", true);
					}
				}
				else {
					log("Passed override function parameter is not a function.", "ERROR", true);
				}
				if (!sessions || !this._isValidSessionList(sessions)) {
					window.close();
					return;
				}
			}

			if (this.gParams.addCurrentSession) // add a "virtual" current session
			{
				sessions.unshift({ name: gSessionManager._string("current_session"), fileName: "*" });
			}
			
			// Do not allow overwriting of open window or browser sessions (clone it so we don't overwrite the global variable)
			for (let i in gSessionManager.mActiveWindowSessions) {
				this.gBannedFileNames[i] = gSessionManager.mActiveWindowSessions[i];
			}
			var currentSessionFileName = gPreferenceManager.get("_autosave_values", "").split("\n")[0];
			if (currentSessionFileName) this.gBannedFileNames[currentSessionFileName] = true;
			
			// hide/show the "Don't show [...] again" checkbox
			this._("checkbox_ignore").hidden = !(this.gParams.ignorable);

			// hide/show the Autosave checkboxes
			this._("checkbox_autosave").hidden = !(this.gParams.autoSaveable);
			this._("save_every").hidden = this._("checkbox_autosave").hidden || !this._("checkbox_autosave").checked;
			
			// hide/show the append/replace radio buttons
			this._("radio_append_replace").hidden = !(this.gParams.append_replace);
			this._("radio_append_replace").selectedIndex = gPreferenceManager.get("overwrite", false) ? 1 : (gPreferenceManager.get("append_by_default", false) ? 2 : 0);
			if (gSessionManager.tabMixPlusEnabled && gPreferenceManager.get("extensions.tabmix.singleWindow", false, true)) {
				if (!this._("radio_append_replace").selectedIndex) this._("radio_append_replace").selectedIndex = 2;
				this._("radio_append").hidden = true;
			}

			this.gBackupNames[gSessionManager._string("backup_session").trim().toLowerCase()] = true;
			this.gBackupNames[gSessionManager._string("autosave_session").trim().toLowerCase()] = true;
			
			var saving = (this.gParams.autoSaveable);
			var grouping = (this.gParams.grouping);
			var loading = (this.gParams.append_replace);  // not true for crash or start session prompt
			var preselect = (this.gParams.preselect) && !aSelectedFileName;
			var selected;
			var selected_time = 0;
			this.gSessionTreeData = [];
			sessions.forEach(function(aSession) {
				var trimName = aSession.name.trim().toLowerCase();
				// ban backup session names
				if (aSession.backup) this.gBackupNames[trimName] = true;
				// Don't allow using same name as active auto or window session - Currently allow all names since active sessions are now referenced by filename.
				//if (this.gBannedFileNames[aSession.fileName]) this.gBannedNames[aSession.name] = true;
				// Don't display loaded sessions in list for load or save or backup items in list for save or grouping
				if (!((aSession.backup && (saving || grouping)) || ((this.gBannedFileNames[aSession.fileName]) && (saving || loading || (this.gParams.addCurrentSession)))))
				{
					// get window and tab counts and group name for crashed session
					if (aSession.fileName == "*") {
						aSession.group = this.gBackupGroupName;
						var counts = this.gParams.crashCount.split(",");
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
					aSession.loaded = this.gBannedFileNames[aSession.fileName] || null;
					
					// Flag latest session
					if ((sessions.latestTime && (sessions.latestTime == aSession.timestamp) && !(this.gParams.addCurrentSession)) || (aSession.fileName == "*")) {
						aSession.latest = true;
					}
					
					// Select previous session if requested to do so and no session name passed
					if (preselect && !this.gParams.filename && ((aSession.autosave && aSession.latest) || (aSession.backup  && (sessions.latestBackUpTime == aSession.timestamp)))) {
						if (selected_time < aSession.timestamp) {
							selected = this.gSessionTreeData.length;
							selected_time = aSession.timestamp;
						}
					}
					
					// When searching make sure previous selected session is selected, if it's still listed
					if (aSelectedFileName && aSelectedFileName == aSession.fileName) {
						selected = this.gSessionTreeData.length;
						preselect = false;
					}

					// select passed in item (if any)
					if (aSession.fileName == this.gParams.filename) selected = this.gSessionTreeData.length;

					// Add session to name list
					this.gSessionNames[trimName] = this.gSessionTreeData.length;
					
					// Push to Tree database and backup
					this.gSessionTreeData.push(aSession);
					
					// Build group menu list
					if (aSession.group && !aSession.backup) {
						// Don't treat special chars in group as regular expression characters
						let groupRegExp = aSession.group.replace(/([\(\)\[\]\^\$\*\+\|\.\\\/])/g,"\\$1");
						let regExp = new RegExp("^" + groupRegExp + "|," + groupRegExp + "$|," + groupRegExp + ",");
						if (!regExp.test(this.gGroupNames.toString())) {
							this.gGroupNames[groupCount++] = aSession.group.trim();
						}
					}
				}
			}, this);
			
			// Make a copy of array
			this.gOriginalSessionTreeData = this.gSessionTreeData.slice(0);
			
			// Sort session list if it was previously sorted
			if (this.sortedBy.column) {
				this.sortSessions();
			}
			
			// Display Tree - or redraw it if already drew it before
			if (!oldSessionTreeRowCount) {
				this.gSessionTree.view = this.sessionTreeView;
			}
			else {
				// Update row count (this redraws the tree)
				this.gSessionTree.treeBoxObject.rowCountChanged(0, this.sessionTreeView.rowCount - oldSessionTreeRowCount);
			}
			
			// select passed in item (if any) and scroll to it
			if (typeof(selected) != "undefined") {
				this.gSessionTree.view.selection.select(selected);
				this.gSessionTree.treeBoxObject.scrollToRow(selected);
			}
			
			if ((this.gParams.selectAll)) this.gSessionTree.view.selection.selectAll()

			// Default to focusing on Session List.  If gTextBox is focused this does nothing for some reason, but that's good.
			// This also causes session list to refresh when updated.
			gSessionManagerSessionPrompt.gSessionTree.focus();
			
			// If there is a text box label, enable text boxes
			if (this.gParams.textLabel)
			{
				this._("text_container").hidden = false;
				this.setDescription(this._("text_label"), this.gParams.textLabel);
				
				// If renaming and name already entered, disable the session selection list
				this.gSessionTree.disabled = this.gParams.filename && !this.gParams.acceptExistingLabel;

				// group text input is enabled when saving or group changing
				if ((this.gParams.grouping) || this.gParams.acceptExistingLabel) 
				{
					this.ggMenuListVisible = !(this._("group-text-container").hidden = false);

					// Pre-populate Group Menu
					this.gGroupNames.sort();
					for (var i in this.gGroupNames) {
						this.ggMenuList.appendItem(this.gGroupNames[i]);
					}
				}
						
				// session text input is enabled when not group changing (i.e., when saving or renaming)
				if (!(this.gParams.grouping)) 
				{
					this.gTextBoxVisible = !(this._("session-text-container").hidden = false);
				
					// Pre-populate the text box with default session name if saving and the name is not banned or already existing.
					// Otherwise disable accept button
					this.populateDefaultSessionName(this.gParams.defaultSessionName);
					if (saving) this.gTextBox.focus();
				}
			}
			
			// Force user to make a selection if no text or group box or not saving (i.e., deleting or renaming)
			if ((this.gNeedSelection = !this.gTextBoxVisible || !this.ggMenuListVisible || !this.gParams.acceptExistingLabel) || (this.gParams.allowNamedReplace))
			{
				this.gSelectSessionTreeActive = true;
				this.onSessionTreeSelect();
				
				// If renaming and rename pre-selected, put focus on text box
				if (this.gParams.callbackData && (this.gParams.callbackData.type == "rename") && this.gParams.filename) {
					this.gTextBox.focus();
				}
			}
			else this.isAcceptable();
		},
		
		populateDefaultSessionName: function(aName, aTabSelect) {
			var trimname = aName.trim().toLowerCase();
			if (this.gParams.acceptExistingLabel && !this.gBannedNames[trimname] && (aTabSelect || (this.gSessionNames[trimname] == undefined) || (this.gParams.allowNamedReplace)))
			{
				this.onTextboxInput(aName);  // Set 2nd paramter to aTabSelect to prevent selecting name from tab tree resulting in textbox taking focus
			}
			else this.gAcceptButton.disabled = true;
		},
		
		onSessionTreeClick: function(aEvent)
		{
			if ((aEvent.button == 0) && !aEvent.metaKey && !aEvent.ctrlKey && !aEvent.shiftKey && !aEvent.altKey) {
				if (aEvent.target.nodeName=="treechildren") {
					switch (aEvent.type) {
						case "click":
							if (this.gTextBoxVisible && !(this.gParams.allowNamedReplace)) this.onTextboxInput(this.gSessionTreeData[this.gSessionTree.currentIndex].name);
							this.gLastSelectedRow = this.gSessionTree.currentIndex;
							break;
						case "dblclick":
							if (!(this.gParams.remove)) 
								this.gAcceptButton.doCommand();
							break;
					}
				}
				else if ((aEvent.type == "click") && (aEvent.target.nodeName == "treecol")) {
					// If not already sorted, this.sortedBy.direction will be 0.  this.sortedBy.column is the column that is sorted.
					var new_sortBy_direction = (this.sortedBy.column == aEvent.target.id) ? -this.sortedBy.direction : 1
					
					// Save selected items so they can be restored
					var selectedFileNames = {};
					var start = new Object();
					var end = new Object();
					var numRanges = this.gSessionTree.view.selection.getRangeCount();

					for (var t = 0; t < numRanges; t++) {
						this.gSessionTree.view.selection.getRangeAt(t,start,end);
						for (var v = start.value; v <= end.value; v++){
							selectedFileNames[this.gSessionTreeData[v].fileName] = true;
						}
					}
					
					// Clear all selected items
					this.gSessionTree.view.selection.clearSelection();
					
					// If inversely sorted and user clicks header again, go back to original order
					if (new_sortBy_direction && (this.sortedBy.column == aEvent.target.id) && (this.sortedBy.direction < 0)) {
						new_sortBy_direction = 0;
						this.gSessionTreeData = this.gOriginalSessionTreeData.slice(0);
					}

					this.sortedBy = { column: ((new_sortBy_direction != 0) ? aEvent.target.id : null), direction: new_sortBy_direction };
					
					// Sort depending on which header is clicked and adjust arrows, only adjusts arrows if this.sortedBy.direction is 0.
					this.sortSessions();
					
					// Recreate Session List index and restore selected items
					for (var i=0; i<this.gSessionTreeData.length; i++) {
						var trimName = this.gSessionTreeData[i].name.trim().toLowerCase();
						this.gSessionNames[trimName] = i;
						
						if (selectedFileNames[this.gSessionTreeData[i].fileName]) {
							this.gSessionTree.view.selection.toggleSelect(i);
						}
					}

					// Redraw the tree
					this.gSessionTree.treeBoxObject.invalidate();
				}
			}
		},
		
		onSessionTreeKeyPress: function(aEvent)
		{
			if (this.gTextBoxVisible && (aEvent.keyCode == aEvent.DOM_VK_RETURN) && (this.gSessionTree.view.selection.count > 0)) {
				this.onTextboxInput(this.gSessionTreeData[this.gSessionTree.currentIndex].name);
				aEvent.preventDefault();
			}
		},
		
		clearSearch: function()
		{
			// Clear search box on first search box click
			if (this.gSearchTextBox.getAttribute("searching") == "false") {
				if (!this.originalSearchValue)
					this.originalSearchValue = this.gSearchTextBox.value;
				this.getSessionsSearchOverride = null;
				this.gSearchTextBox.value = '';
				this.gSearchTextBox.setAttribute("searching", "true");
			}
		},
		
		resetSearch: function() {
			if (!this.gSearching) {
				this.getSessionsSearchOverride = null;
				this.gSearchTextBox.setAttribute("searching", "false");
				this.gSearchTextBox.value = this.originalSearchValue;
			}
		},
		
		// Don't search immediately, add delay so we don't need to search needlessly over and over
		// while user is typing
		doSearch: function()
		{
			if (this.gSearchTimer)
				window.clearTimeout(this.gSearchTimer);
				
			if (this.gSearchTextBox.value == '')
				this.doSearch2();
			else if (this.gSearchTextBox.getAttribute("searching") == "true") {
				this.gSearchTimer = window.setTimeout(gSessionManagerSessionPrompt.doSearch2, 450);
			}
		},
		
		doSearch2: function()
		{
			gSessionManagerSessionPrompt.gSearchTimer = null;
			var selectedFileName = ((gSessionManagerSessionPrompt.gSessionTree.view.selection.count == 1) && (gSessionManagerSessionPrompt.gSessionTree.currentIndex != -1)) ?
									gSessionManagerSessionPrompt.gSessionTreeData[gSessionManagerSessionPrompt.gSessionTree.currentIndex].fileName : null;
			
			// If no search text, set values back to default
			if (gSessionManagerSessionPrompt.gSearchTextBox.value == '') {
				gSessionManagerSessionPrompt.gSearching = false;
				gSessionManagerSessionPrompt.resetSearch();
			}
			else {
				gSessionManagerSessionPrompt.gSearching = true;
				
				// if SQL cache is enabled, but hasn't been read, read it now, when cache is done reading it will call doSearch2.
				if (!gSessionManagerSessionPrompt.gReadSQLCache && gSessionManager.mPref["use_SQLite_cache"]) {
					gSQLManager.readSessionDataFromSQLCache(gSessionManagerSessionPrompt.sessionCacheCallback);
					gSessionManagerSessionPrompt.gReadSQLCache = 1;
				}
				else {
					// If nothing changed don't search again unless we are waiting for cache results to return
					if (gSessionManagerSessionPrompt.gSearchTextBox.value == gSessionManagerSessionPrompt.gLastSearchText)
						return;
					gSessionManagerSessionPrompt.gLastSearchText = gSessionManagerSessionPrompt.gSearchTextBox.value;
				}
			
				gSessionManagerSessionPrompt.getSessionsSearchOverride = function() {
					let search_value = gSessionManagerSessionPrompt.gSearchTextBox.value;
					let search_keyword = search_value.slice(0,2);
					let search_type = 15;
					// Use key shortcuts for searching based on Awesome bar shortcuts:
					// * = Session Name, + = Group name, # = Tab title, @ = Tab url, ^ = Tab history
					if (search_keyword[1] == " ") {
						let found = true;
						switch(search_keyword[0]) {
							case this.gSearchTitle:
								search_type = 1;
								break;
							case this.gSearchURL:
								search_type = 2;
								break;
							case this.gSearchName:
								search_type = 4;
								break;
							case this.gSearchGroup:
								search_type = 8;
								break;
							case this.gSearchHistroy:
								search_type = 16;
								break;
							default:
								found = false;
								break;
						}
						if (found)
							search_value = search_value.slice(2);
					}
					
					let regex_arg = ((search_value.length < 2) || (search_value[0] != '"') || (search_value[search_value.length-1] != '"')) ? "i" : "";
					// remote quotes from search string if surrounds by quotes (i.e, regex_arg is not "i")
					if (regex_arg != "i")
						search_value = search_value.substr(1, search_value.length-2);
					// reg expresion can't end in "\"
					if (search_value[search_value.length-1] == "\\" && search_value[search_value.length-2] != "\\")
						search_value = search_value.slice(0,search_value.length-1);
					let regexp = new RegExp(search_value, regex_arg);
					let sessions = null;
					
					// Get true sessions (use override if set)
					if (gSessionManagerSessionPrompt.gParams.getSessionsOverride && typeof gSessionManagerSessionPrompt.gParams.getSessionsOverride == "function") {
						try {
							sessions = gSessionManagerSessionPrompt.gParams.getSessionsOverride();
						} catch (ex) { 
							logError(ex);
							sessions = gSessionManager.getSessions();
						}
					}
					else {
						sessions = gSessionManager.getSessions();
					}

					// Get tab data as an array of file names indicating whether the tab data matches the regular expression.
					let tabData = (search_type & 19 ) ? gSessionManagerSessionPrompt.searchTitlesUrls(regexp, search_type) : null;
					sessions = sessions.filter(function(aSession) {
						return (((search_type & 4 ) && regexp.test(aSession.name)) || ((search_type & 8 ) && regexp.test(aSession.group)) || (tabData && tabData[aSession.fileName]));
					});
					return sessions;
				}
			}
			// Update window
			gSessionManagerSessionPrompt.updateWindow(selectedFileName);
			// Keep focus on search box	
			gSessionManagerSessionPrompt.gSearchTextBox.focus();
		},
		
		searchTitlesUrls: function(regexp, search_type) {
			if (!gSessionManagerSessionPrompt.gSessionCache) return null;
			
			let tabData = [];
			gSessionManagerSessionPrompt.gSessionCache.forEach(function(element) {
				// Match title and urls when searching for everything or specifically for titles or urls.  Only match tab history when searching history.
				if (((search_type & 1) && (element.titles.search(regexp) != -1)) || ((search_type & 2) && (element.urls.search(regexp) != -1)) ||
				        ((search_type & 16) && (element.history.search(regexp) != -1)))
					tabData[element.fileName] = true;
			});
			return tabData;
		},
		
		sessionCacheCallback: function(sessionData, aFileNames, aFailedToDecrypt) {
			// If decryption failed, user didn't enter master password so bug him again :)
			if (aFailedToDecrypt) {
				gSessionManagerSessionPrompt.gReadSQLCache = 0;
				return;
			}
		
			gSessionManagerSessionPrompt.gSessionCache = [];
			sessionData.forEach(function(aSession) {
				if (aSession.state) {
					let window_state = gSessionManager.JSON_decode(aSession.state);
					let history = [], titles = [], urls = [];
					window_state.forEach(function(aWindow) {
						aWindow.tabData.forEach(function(aTabData) {
							aTabData.history.forEach(function(aEntry) {
								if (aEntry.current) {
									titles.push(aEntry.title);
									urls.push(aEntry.url);
								}
								else {
									history.push(aEntry.title);
									history.push(aEntry.url);
								}
							});
						});
					});
					gSessionManagerSessionPrompt.gSessionCache.push({ fileName: aSession.fileName, history: history.toString(), titles: titles.toString(), urls: urls.toString() });
				}
			});
			let old_cache_state = gSessionManagerSessionPrompt.gReadSQLCache;
			gSessionManagerSessionPrompt.gReadSQLCache = 2;
			// if started searching while cache was being read, do search now
			if (old_cache_state == 1) {
				if (gSessionManagerSessionPrompt.gSearchTimer)
					window.clearTimeout(gSessionManagerSessionPrompt.gSearchTimer);
				gSessionManagerSessionPrompt.doSearch2();
			}
		},
		
		displayTabTree: function(saveToSave)
		{
				// save current session tree height before doing any unhiding (subtract one if called initiall since height is off by one in that case)
				var currentSessionTreeHeight = this.gSessionTree.treeBoxObject.height - (!this.gFinishedLoading ? 0 : 1);
				var tabTreeWasHidden = this.gTabTreeBox.hidden;

				// hide tab tree and splitter if more or less than one item is selected or muliple selection is enabled, but not deleting (used for converting sessions)
				// hide the click note if append/replace buttons are displayed (manual load).  Don't hide when searching unless there are no sessions.
				var hideTabTree = !this.gParams.autoSaveable && !!((this.gSessionTree.view.selection.count != 1) || ((this.gParams.multiSelect) && !(this.gParams.remove)));
				this.gTreeSplitter.hidden = this.gTabTreeBox.hidden = hideTabTree;
				this.gCtrlClickNote.hidden = hideTabTree || !(this.gParams.append_replace) || this.gParams.autoSaveable;
				
				// if displaying the tab tree, initialize it and then, if the tab tree was hidden, 
				// resize the window based on the current persisted height of the tab tree and the
				// current session tree height.  
				if (!hideTabTree) {
					// Change column label to correct value
					if (this.gParams.remove)
						this._("restore").setAttribute("label", gSessionManager._string("remove_session_ok"));
					else if (this.gParams.autoSaveable) 
						this._("restore").setAttribute("label", gSessionManager._string("save"));
					else 
						this._("restore").setAttribute("label", gSessionManager._string("load_session_ok"));
					gSessionManagerSessionBrowser.initTreeView(this.gParams.autoSaveable ? "" : this.gSessionTreeData[this.gSessionTree.currentIndex].fileName, this.gParams.remove, this.gParams.startupPrompt, this.gParams.autoSaveable);
				}
				
				// If tab tree was displayed or hidden or now saving, adjust session tree height
				if (this.gFinishedLoading && (tabTreeWasHidden != hideTabTree || (this.gParams.autoSaveable && !saveToSave))) {
					if (!hideTabTree && this.gTabTree.hasAttribute("height"))
					{
						this.gTabTree.height = this.gTabTree.getAttribute("height");
					}
					
					// Fix session tree height to prevent it from changing
					this.adjustSessionTreeHeight(currentSessionTreeHeight);
				}
		},
		
		onSessionTreeSelect: function()
		{
			// Only process when gSelectSessionTreeActive is true
			if (!this.gSelectSessionTreeActive) return;

			// If no session name or group name text box, disable the accept button if nothing selected.
			// Otherwise isAcceptable when changing groups or onTextboxInput otherwise.
			if (!this.gTextBoxVisible && !this.ggMenuListVisible)
			{
				this.gAcceptButton.disabled = this.gSessionTree.view.selection.count == 0;
				
				// Display Tab Tree
				this.displayTabTree();
			}
			else
			{
				if (this.gTextBoxVisible) this.onTextboxInput(null, false, true);
				else this.isAcceptable();
			}
		},

		onTextboxInput: function(aNewValue, aDontTakeFocus, aTreeSelect)
		{
			if (aNewValue)
			{
				var match = /   \([0-9]+\/[0-9]+\)$/m.exec(aNewValue);
				if (match)
				{
					aNewValue = aNewValue.substring(0,match.index);
				}
				this.gTextBox.value = aNewValue;
				if (!aDontTakeFocus) setTimeout(function() { gSessionManagerSessionPrompt.gTextBox.select(); gSessionManagerSessionPrompt.gTextBox.focus(); }, 0);
			}
			
			var check_for_existing_sessions = true;
			var input = this.gTextBox.value.trim().toLowerCase();
			var oldWeight = !!this.gAcceptButton.style.fontWeight;
			var newWeight = false;
			
			// Only consider the existing name when selecting from session tree or wehn value is passed in (not when typing)
			if (gSessionManager.mPref["allow_duplicate_session_names"] && !(aNewValue || aTreeSelect)) {
				this.gExistingName = -1;
				check_for_existing_sessions = false;
			}
			else {
				this.gExistingName = (this.gSessionNames[input] != undefined) ? this.gSessionNames[input] : -1;
				newWeight = !!((this.gExistingName >= 0) || ((this.gParams.allowNamedReplace) && this.gSessionTree.view.selection.count > 0) || this.gExistingSessionNames[input]);
			}
				
			if (!this._("checkbox_autosave").hidden) {
				var currentChecked = this._("checkbox_autosave").checked;
				if (this.gExistingName >= 0) {
					this._("checkbox_autosave").checked = this.gSessionTreeData[this.gExistingName].autosave != "false";
					this._("autosave_time").value = this.gSessionTreeData[this.gExistingName].autosave_time || "";
				}
				else if (this.gExistingSessionNames[input] && check_for_existing_sessions) {
					this._("checkbox_autosave").checked = this.gExistingSessionNames[input].autosave != "false";
					this._("autosave_time").value = this.gExistingSessionNames[input].autosave_time || "";
				}
				else if (this.gParams.allowNamedReplace && check_for_existing_sessions && (this.gSessionTree.view.selection.count == 1)) {
					this._("checkbox_autosave").checked = this.gSessionTreeData[this.gSessionTree.view.selection.currentIndex].autosave != "false";
					this._("autosave_time").value = this.gSessionTreeData[this.gSessionTree.view.selection.currentIndex].autosave_time || "";
				}
				else {
					this._("checkbox_autosave").checked = false;
					this._("autosave_time").value = "";
				}
				if (currentChecked != this._("checkbox_autosave").checked) this._save_every_update();
			}
			
			if (!this.gNeedSelection && oldWeight != newWeight)
			{
				this.gAcceptButton.label = (newWeight && this.gParams.acceptExistingLabel)?this.gParams.acceptExistingLabel:this.gParams.acceptLabel;
				this.gAcceptButton.style.fontWeight = (newWeight)?"bold":"";
				// Show append button if replace button is shown.
				this.gExtraButton.hidden = this.gAcceptButton.label != this.gParams.acceptExistingLabel

				// When replace changes to save, clear current selection and group name if saving 
				if (!newWeight && this.gParams.acceptExistingLabel) {
					this.gSessionTree.view.selection.clearSelection();
					if (this.ggMenuListVisible) this.ggMenuList.value = "";
				}
			}
			this.gExtraButton.disabled = this.gExtraButton.hidden || this._("checkbox_autosave").checked;

			// Highlight matching item when accept label changes to replace and copy in group value (only when saving and not replacing name)
			if (newWeight && this.gParams.acceptExistingLabel) {
				// if not overwriting session with new name, select the session based on the entered name
				if (!this.gParams.allowNamedReplace) this.gSessionTree.view.selection.select(this.gExistingName);
				// use selected session's group
				if (this.ggMenuListVisible && (this.gSessionTree.view.selection.currentIndex >= 0))
					this.ggMenuList.value = this.gSessionTreeData[this.gSessionTree.view.selection.currentIndex].group;
				else if (this.gExistingSessionNames[input])
					this.ggMenuList.value = this.gExistingSessionNames[input].group;
			}
				
			this.isAcceptable();
		},

		isAcceptable: function(aNotAcceptable) 
		{
			var badSessionName = false;
			var badGroupName = false;
			
			if (this.ggMenuListVisible) {
				var groupName = this.ggMenuList.value.trim();
				badGroupName = (groupName == this.gBackupGroupName)
				this.ggMenuList.inputField.setAttribute("badname", badGroupName);
			}
			
			if (this.gTextBoxVisible) {
				var input = this.gTextBox.value.trim().toLowerCase();
				var backupSessionName = BACKUP_SESSION_REGEXP.test(input + ".session");
				this.gTextBox.setAttribute("badname", this.gBackupNames[input] || backupSessionName);
				badSessionName = !input || this.gBackupNames[input] || this.gBannedNames[input] || backupSessionName;
			}

			this.gAcceptButton.disabled = this.gExtraButton.disabled = aNotAcceptable ||
				this.gInvalidTime || badSessionName || badGroupName || (this.gParams.autoSaveable && gSessionManager.isPrivateBrowserMode()) ||
				(this.gParams.autoSaveable && (gSessionManagerSessionBrowser.gNoTabsChecked || (gSessionManagerSessionBrowser.treeView.treeBox && gSessionManagerSessionBrowser.treeView.rowCount == 0))) ||
				(this.gNeedSelection && (this.gSessionTree.view.selection.count == 0 || (this.gExistingName >= 0)));
		},

		// aParam = true if user clicked extra1 button (Append), false otherwise
		onAcceptDialog: function(aParam)
		{
			// Put up warning prompt if deleting
			if (this.gParams.remove) {
				var dontPrompt = { value: false };
				var partial = gSessionManagerSessionBrowser.gAllTabsChecked ? "" : "partial_";
				if (gPreferenceManager.get("no_" + partial + "delete_prompt") || PROMPT_SERVICE.confirmEx(window, gSessionManager.mTitle, gSessionManager._string(partial + "delete_confirm"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, gSessionManager._string("prompt_not_again"), dontPrompt) == 0) {
					if (dontPrompt.value) {
						gPreferenceManager.set("no_" + partial + "delete_prompt", true);
					}
				}
				else return false;
			}

			let filename;
			if (this.gNeedSelection || ((this.gParams.allowNamedReplace) && this.gSessionTree.view.selection.count > 0))
			{
				// If saving and replacing using the default name put up overwrite prompt
				if (this.gParams.autoSaveable && this.gParams.allowNamedReplace && this.gSessionTree.view.selection.count > 0) {
					var dontPrompt = { value: false };
					if (gPreferenceManager.get("no_overwrite_prompt") || 
						PROMPT_SERVICE.confirmEx(null, gSessionManager.mTitle, gSessionManager._string("overwrite_prompt"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, gSessionManager._string("prompt_not_again"), dontPrompt) == 0)
					{
						if (dontPrompt.value)
						{
							gPreferenceManager.set("no_overwrite_prompt", true);
						}
					}
					else {
						return false;
					}
				}
			
				var selectedFileNames = [];
				var start = new Object();
				var end = new Object();
				var numRanges = this.gSessionTree.view.selection.getRangeCount();

				for (var t = 0; t < numRanges; t++) {
					this.gSessionTree.view.selection.getRangeAt(t,start,end);
					for (var v = start.value; v <= end.value; v++){
						selectedFileNames.push(this.gSessionTreeData[v].fileName);
					}
				}
				filename = selectedFileNames.join("\n");
			}
			else if (this.gExistingName >= 0)
			{
				var dontPrompt = { value: false };
				if (aParam || gPreferenceManager.get("no_overwrite_prompt") || 
					PROMPT_SERVICE.confirmEx(null, gSessionManager.mTitle, gSessionManager._string("overwrite_prompt"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, gSessionManager._string("prompt_not_again"), dontPrompt) == 0)
				{
					filename = this.gSessionTreeData[this.gExistingName].fileName;
					if (dontPrompt.value)
					{
						gPreferenceManager.set("no_overwrite_prompt", true);
					}
				}
				else {
					return false;
				}
			}
			else
			{
				filename  = "";
			}
			
			gSessionManager.sessionPromptReturnData = { 
				append: ((this._("radio_append").selected && !this._("radio_append_replace").hidden) || aParam),
				append_window: this._("radio_append_window").selected, 
				autoSave: this._("checkbox_autosave").checked,
				autoSaveTime: (this._("checkbox_autosave").checked ? parseInt(this._("autosave_time").value.trim()) : null),
				filename: filename,
				groupName: this._("group_menu_list").value.trim(),
				ignore: this._("checkbox_ignore").checked, 
				sessionState: gSessionManagerSessionBrowser.gAllTabsChecked ? null : gSessionManagerSessionBrowser.storeSession(this.gParams.autoSaveable),
				sessionName: this._("text_box").value.trim()
			};
			
			// Writing to a file is asynchronous so we don't want to refresh until write is finished.
			let writing_file = false;
			if (!this.modal) {
				try {
					writing_file = gSessionManager.sessionPromptCallBack(this.gParams.callbackData);
				} catch(ex) {
					logError(ex);
				}
				// clear out return data and preset to not accepting
				gSessionManager.sessionPromptReturnData = null;
				
				// if user wants to close window, do it
				if (!this._("leave_window_open").checked)
					window.close();
				else if (!writing_file)
					this.updateWindow();
				return false;
			}
			else {
				// If modal, set "accept" value
				window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock).SetInt(0, 1);
			}
			
			// Click extra button doesn't close window so do that here
			if (aParam) window.close();
		},
		
		onSelectMenu: function(aEvent) {
			if (this._("actionButton").label == aEvent.explicitOriginalTarget.label) return;

			// Cleanup saved window if it exists
			gSessionManagerSessionBrowser.oneWindow = null;
			
			switch(aEvent.explicitOriginalTarget.id) {
				case "save":
					gSessionManager.save();
					break;
				case "saveWin":
					gSessionManager.saveWindow(gSessionManager.getMostRecentWindow("navigator:browser"));
					break;
				case "load": 
					gSessionManager.load();
					break;
				case "rename":
					gSessionManager.rename();
					break;
				case "group-menu":
					gSessionManager.group();
					break;
				case "remove":
					gSessionManager.remove();
					break;
			}
			
			// Disable saving if no windows
			this.checkForNoWindows();
		},
		
		sortSessions: function() {
			// sort session list data if this.sortedBy.direction is set
			if (this.sortedBy.direction != 0) {
				switch (this.sortedBy.column) {
					case "name":
						this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
							return gSessionManagerSessionPrompt.sortedBy.direction * (a.name.toLowerCase().localeCompare(b.name.toLowerCase())); 
						});
						break;
					case "group":
						this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
							return gSessionManagerSessionPrompt.sortedBy.direction * (a.group.toLowerCase().localeCompare(b.group.toLowerCase())); 
						});
						break;
					case "win_count":
						this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
							return gSessionManagerSessionPrompt.sortedBy.direction * (parseInt(a.windows) - parseInt(b.windows)); 
						});
						break;
					case "tab_count":
						this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
							return gSessionManagerSessionPrompt.sortedBy.direction * (parseInt(a.tabs) - parseInt(b.tabs)); 
						});
						break;
				}
			}
			
			// update header arrorws
			var cols = this._("sessionTreeCols");
			for (var i=0; i < cols.childNodes.length; i++) {
				var sortText = this.sortedBy.direction ? ((this.sortedBy.direction>0) ? "ascending" : "descending") : "natural";
				cols.childNodes[i].setAttribute("sortDirection", ((cols.childNodes[i].id == this.sortedBy.column) ? sortText : "natural"))
			}
		},

		setDescription: function(aObj, aValue)
		{
			aValue.split("\n").forEach(function(aLine) {
				let description = document.createElement("description");
				description.className = "addedDescription";
				aObj.appendChild(description).textContent = aLine;
			});
		},

		removeDescriptions: function() {
			let descriptions = document.getElementsByTagName("description");
			let ignored = 0;
			while (descriptions.length > ignored) {
				if (descriptions[ignored].className == "addedDescription") {
					descriptions[ignored].parentNode.removeChild(descriptions[ignored]);
				}
				else {
					ignored++;
				}
			}
		},

		persistTreeHeights: function() {
			// only persist tree heights is neither is collapsed to prevent "giant" trees
			if (this.gTreeSplitter.getAttribute("state") != "collapsed") {
				// persist session tree height if it has a height, subtract one if tab Tree is hidden because one is added if it is
				if (this.gSessionTree && this.gSessionTree.treeBoxObject.height > 0) {
					var tweak = this.gTabTreeBox.hidden ? 1 : 0;
					this.persist(this.gSessionTree, "height", this.gSessionTree.treeBoxObject.height - tweak);
					log("persistTreeHeights: persist session tree height = " + this.gSessionTree.treeBoxObject.height + ", tweak = " + tweak, "DATA");
				}
				// persist tab tree height if it has a height
				if (this.gTabTree && this.gTabTree.treeBoxObject.height > 0) {
					this.persist(this.gTabTree, "height", this.gTabTree.treeBoxObject.height);
					log("persistTreeHeights: persist tab tree height = " + this.gTabTree.treeBoxObject.height, "DATA");
				}
			}
			log("persistTreeHeights: session tree height = " + this.gSessionTree.getAttribute("height") + ", tab tree height = " + this.gTabTree.getAttribute("height"), "DATA");
		},

		// Fix session tree height to prevent it from changing
		adjustSessionTreeHeight: function(currentSessionTreeHeight) {
			// Restore height and save it for when window closes
			this.gSessionTree.height = currentSessionTreeHeight;
			
			// The following line keeps the window width from increasing when sizeToContent is called.
			this._("sessionmanagerPrompt").width = window.innerWidth - 1;
			window.sizeToContent();
			// The following is needed because the session tree usually shrinks when calling the above
			window.innerHeight = window.innerHeight - this.gSessionTree.treeBoxObject.height + currentSessionTreeHeight;
			
			// Adjust window so it's not offscreen
			this.adjustWindowSizeAndPosition();
			log("adjustSessionTreeHeight: window.screenY = " + window.screenY + ", window.screen.availHeight = " + window.screen.availHeight + ", window.outerHeight = " + window.outerHeight, "DATA");
		},
		
		adjustWindowSizeAndPosition: function() {
			// Make sure window height isn't larger than screen height
			if (window.screen.availHeight < window.outerHeight) {
				window.outerHeight = window.screen.availHeight;
			}
			// Make sure the bottom of the window is visible by moving the window up if necessary
			if (window.screenY + window.outerHeight > window.screen.availHeight) {
				window.screenY = window.screen.availHeight - window.outerHeight;
			}
		},

		// This is needed because disabled menu items are re-eneabled once menu is shown.  This is called from onpopupshow.
		updateForPrivateBrowsingMode: function() 
		{
			let inPrivateBrowsing = gSessionManager.isPrivateBrowserMode();
			let no_windows = !gSessionManager.getBrowserWindows().length;
			gSessionManager.setDisabled(this._("save"), inPrivateBrowsing || no_windows);
			gSessionManager.setDisabled(this._("saveWin"), inPrivateBrowsing || no_windows);
		},
		
		checkPrivateBrowsingMode: function(inPrivateBrowsing, aSaving, aJustOpened)
		{
			// disable menu if saving
			let menu = this._("actionButton");
			menu.setAttribute("private", ((menu.label == this._("save").label) || (menu.label == this._("saveWin").label)) ? "true" : "false");
			
			// If saving, disable, the save or append button
			if (aSaving) {
				if (inPrivateBrowsing) {
					this.gAcceptButton.disabled = true;
					this.gExtraButton.disabled = true;
				}
				else if (!aJustOpened) this.isAcceptable();
			}
		},
		
		checkForNoWindows: function()
		{
			// disable menu if saving
			let no_windows = !gSessionManager.getBrowserWindows().length;
			let menu = this._("actionButton");
			menu.setAttribute("nowindows", (no_windows && ((menu.label == this._("save").label) || (menu.label == this._("saveWin").label))) ? "true" : "false");
		},

		_: function(aId)
		{
			return document.getElementById(aId);
		},

		_isValidSessionList: function(aSessions)
		{
			if (aSessions==null || typeof(aSessions)!="object" || typeof(aSessions.length)!="number" || 
				aSessions.length == 0 || !aSessions[0].name) {
				log("Override function returned an invalid session list.", "ERROR", true);
				return false;
			}
			return true;
		},

		_save_every_update: function()
		{
			var checked = gSessionManagerSessionPrompt._('checkbox_autosave').checked;
			var save_every_height = null;
			
			gSessionManagerSessionPrompt._('save_every').hidden = !checked;
			
			// resize window
			if (checked) {
				save_every_height = parseInt(window.getComputedStyle(gSessionManagerSessionPrompt._('save_every'), "").height);
				if (isNaN(save_every_height)) save_every_height = 0;
				gSessionManagerSessionPrompt.gSavedEveryHeight = save_every_height;
				window.innerHeight += save_every_height;
			}
			else {
				if (typeof(gSessionManagerSessionPrompt.gSavedEveryHeight) == "number") {
					window.innerHeight -= gSessionManagerSessionPrompt.gSavedEveryHeight;
				}
			}
		},

		isNumber: function(aTextBox)
		{
			this.gInvalidTime = !/^([1-9]\d*)?$/.test(aTextBox.value);
			aTextBox.setAttribute("badname", this.gInvalidTime ? "true" : "false");
			
			this.isAcceptable();
		},
		
		correctSizeAndPosition: function(currentAcceptPositionDifference, topResize) 
		{
			var moveUp = topResize || ((window.screenY + window.outerHeight + this.gAcceptPositionDifference - currentAcceptPositionDifference) > window.screen.availHeight);
			window.resizeTo(window.outerWidth,window.outerHeight + this.gAcceptPositionDifference - currentAcceptPositionDifference);
			if (moveUp) window.moveBy(0, currentAcceptPositionDifference - this.gAcceptPositionDifference);
			delete this.gTimerId;
		},

		// if the accept button is no longer moving when resizing, the window is too small so make it bigger.
		resize: function()
		{
			var currentAcceptPositionDifference = window.outerHeight - this.gAcceptButton.boxObject.y;
			var topResize = gSessionManagerSessionPrompt.gLastScreenY != window.screenY;
			gSessionManagerSessionPrompt.gLastScreenY = window.screenY;
			if (!this.gAcceptPositionDifference) {
				this.gAcceptPositionDifference = currentAcceptPositionDifference;
			}
			else if (currentAcceptPositionDifference < this.gAcceptPositionDifference) {
				if (this.gTimerId) {
					clearTimeout(this.gTimerId);
					delete this.gTimerId;
				}
				this.gTimerId = setTimeout(function() { gSessionManagerSessionPrompt.correctSizeAndPosition(currentAcceptPositionDifference, topResize); }, 100);
			}
		},

		// Tree controller

		sessionTreeView: {
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

			get rowCount()                     { return gSessionManagerSessionPrompt.gSessionTreeData.length; },
			setTree: function(treeBox)         { this.treeBox = treeBox; },
			getCellText: function(idx, column) { 
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx]) {
					switch(column.id) {
						case "name":
							return gSessionManagerSessionPrompt.gSessionTreeData[idx].name;
							break;
						case "group":
							return gSessionManagerSessionPrompt.gSessionTreeData[idx].group;
							break;
						case "win_count":
							return gSessionManagerSessionPrompt.gSessionTreeData[idx].windows;
							break;
						case "tab_count":
							return gSessionManagerSessionPrompt.gSessionTreeData[idx].tabs;
							break;
					}
				}
				return null;
			},
			canDrop: function(idx, orient)      { return false; },
			isContainer: function(idx)          { return false; },
			isContainerOpen: function(idx)      { return false; },
			isContainerEmpty: function(idx)     { return false; },
			isSelectable: function(idx, column) { return false; },
			isSeparator: function(idx)          { return false; },
			isSorted: function()                { return gSessionManagerSessionPrompt.sortedBy != 0; },
			isEditable: function(idx, column)   { return false; },
			getLevel: function(idx)             { return 0; },
			getParentIndex: function(idx)       { return -1; },
			getImageSrc: function(idx, column)  { return null; },

			hasNextSibling: function(idx, after) {
				return (idx <= after) && (idx < gSessionManagerSessionPrompt.gSessionTreeData.length - 1) && 
				       (after < gSessionManagerSessionPrompt.gSessionTreeData.length - 1);
			},

			getCellProperties: function(idx, column, prop) {
				if ((column.id == "group") && (gSessionManagerSessionPrompt.gSessionTreeData[idx].backup)) 
					prop.AppendElement(this._getAtom("disabled"));
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx].latest) 
					prop.AppendElement(this._getAtom("latest"));
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx].loaded)
					prop.AppendElement(this._getAtom("disabled"));
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx].autosave)
					prop.AppendElement(this._getAtom(gSessionManagerSessionPrompt.gSessionTreeData[idx].autosave));
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
		},
	}
}
