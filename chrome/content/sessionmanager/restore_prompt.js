gSessionManager.restorePrompt = function() {
	this.onLoad(true);
	this.onLoad = function() { };
	this.onUnload = function() { };
				
	// Set to not delete stored autosave name and time by default
	var deletePrefs = false;

	// Don't try to encrypt backup file by default
	this.delPref("_encrypt_file");
	
	// Don't recover by default
	this.delPref("_recovering");
	
	// Default to user not selecting tabs
	this.delPref("_chose_tabs");
	
	// default count variable
	var countString = "";
	
	var session = null, backupFile = null, state = null, count = null;
	var	screensize = screen.width + "x" + screen.height;
			
	// Get count from crashed session and prepare to save it.  Don't save it yet or it will show up in selection list.
	var file = this.getProfileFile("sessionstore.js");
	
	// If file does not exist, try looking for SeaMonkey's sessionstore file
	if (!file.exists()) {
		file = this.getProfileFile("sessionstore.json");
	}
	
	if (file.exists())
	{
		try {
			var name = this.getFormattedName("", new Date(file.lastModifiedTime), this._string("crashed_session"));
			state = this.readFile(file);
			count = this.getCount(state);
			session = this.nameState(state, name + "\ntimestamp=" + file.lastModifiedTime + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + this._string("backup_sessions") + "\tscreensize=" + screensize);
			backupFile = this.getSessionDir(this.mBackupSessionName, true);
			
			if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
		}
		catch(ex) { 
			this.logError(ex); 
		}
	}
	
	var params = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
	params.SetInt(0, 0);
			
	var values = { name: "*", addCurrentSession: true, ignorable: false, count: countString }
	var fileName = (location.search != "?cancel")?(this.prompt(this._string("recover_session"), this._string("recover_session_ok"), values)?values.name:""):"";
	if (fileName != "*")
	{
		if (fileName)
		{
			this.setPref("_recovering", fileName);
		}
		else if (!this.getPref("save_window_list", false))
		{
			this.clearUndoData("window", true);
		}
		params.SetInt(0, 1); // don't recover the crashed session
	}
	
	this.mPref_encrypt_sessions = this.getPref("encrypt_sessions", false);
	// actually save the crashed session
	if (session && backupFile) {
		this.writeFile(backupFile, session);
		if (this.mPref_encrypt_sessions) this.setPref("_encrypt_file", backupFile.leafName);
	}
	
	// If user chose to prompt for tabs and selected a filename
	if (fileName && values.choseTabs) {
		// if recovering current session, recover it from our backup file
		if (fileName == "*") {
			fileName = backupFile.leafName;
			params.SetInt(0, 1); // don't recover the crashed session
			this.setPref("_recovering", fileName);
		}
		this.setPref("_chose_tabs", true);
	}
		
	var autosave_values = this.getPref("_autosave_values", "").split("\n");
	var autosave_name = autosave_values[0];
	if (autosave_name)
	{
		// if not recovering last session (does not including recovering last session, but selecting tabs)
		if (fileName != "*")
		{
			// Get name of chosen session
			var chosen_name = null;
			if (/^(\[SessionManager v2\])(?:\nname=(.*))?/m.test(this.readSessionFile(this.getSessionDir(fileName), true))) {
				chosen_name = RegExp.$2;
			}
			
			// not recovering autosave session or current session (selecting tabs), save the autosave session first
			if (values.choseTabs || ((chosen_name != autosave_name) && (fileName != backupFile.leafName)))
			{
				// delete autosave preferences
				deletePrefs = true;
				
				this.log("Saving crashed autosave session " + autosave_name, "DATA");
				var temp_state = this.readFile(file);
				// encrypt if encryption enabled
				if (this.mPref_encrypt_sessions) {
					this.mPref_encrypted_only = this.getPref("encrypted_only", false);
					temp_state = this.decryptEncryptByPreference(temp_state);
				}
				
				if (temp_state) {
					var autosave_time = isNaN(autosave_values[2]) ? 0 : autosave_values[2];
					var autosave_state = this.nameState(temp_state, autosave_name + 
					                     "\ntimestamp=" + file.lastModifiedTime + "\nautosave=session/" + autosave_time +
										 "\tcount=" + count.windows + "/" + count.tabs + 
										 (autosave_values[1] ? ("\tgroup=" + autosave_values[1]) : ""));
					this.writeFile(this.getSessionDir(this.makeFileName(autosave_name)), autosave_state);
				}
			}
			// choose to recover autosave session so just recover last session
			else 
			{
				// we could delete the autosave preferences here, but it doesn't matter (actually it saves us from saving prefs.js file again)
				this.delPref("_recovering");
				params.SetInt(0, 0);
			}
		}
	}
	
	// delete autosave preferences and save preference file
	if (deletePrefs) {
		this.delPref("_autosave_values");
		// do this via a preference so we don't save twice in case user loads a different auto save sessions
		this.setPref("_save_prefs", true);  
	}
	
	// Don't prompt for a session again if user cancels crash prompt
	this.setPref("_no_prompt_for_session", true);
};
		
gSessionManager.restorePrompt();
window.close();
