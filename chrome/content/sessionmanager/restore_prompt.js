gSessionManager.restorePrompt = function() {
	this.onLoad(true);
	this.onLoad = function() { };
	this.onUnload = function() { };
			
	// Delete stored autosave name by default
	this.delPref("_autosave_name");
	
	// Backup and delete autosave time by default
	var autosave_time = this.getPref("_autosave_time", 0);
	this.delPref("_autosave_time");
	
	// Don't allow reloading
	this.delPref("_allow_reload");
	
	// Don't try to encrypt backup file by default
	this.delPref("_encrypt_file");
	
	// default count variable
	var countString = "";
	
	var session = null, backupFile = null, state = null;
			
	// Get count from crashed session and prepare to save it.  Don't save it yet or it will show up in selection list.
	var file = this.getProfileFile("sessionstore.js");
	if (file.exists())
	{
		try {
			var name = this.getFormattedName("", new Date(file.lastModifiedTime), this._string("crashed_session"));
			state = this.readFile(file);
			count = this.getCount(state);
			session = this.nameState(state, name + "\ntimestamp=" + file.lastModifiedTime + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + this._string("backup_sessions"));
			backupFile = this.getSessionDir(this.mBackupSessionName, true);
			
			if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
		}
		catch(ex) { 
			dump(ex + "\n"); 
		}
	}
	
	var params = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
	params.SetInt(0, 0);
			
	var values = { name: "*", addCurrentSession: true, ignorable: false, tabprompt: (this.mAppVersion >= "1.9.1"), count: countString }
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
	if (fileName && values.promptForTabs) {
		// if recovering current session, recover it from our backup file
		if (fileName == "*") {
			fileName = backupFile.leafName;
			params.SetInt(0, 1); // don't recover the crashed session
			this.setPref("_recovering", fileName);
		}
		this.setPref("_prompt_for_tabs", true);
	}
		
	// find if there was an autosave session active at time of crash and get its name
	state = this._safeEval(state);
	if (state && (state.windows.length > 0) && state.windows[0].extData && state.windows[0].extData._sm_autosave_name)
	{
		var autosave_name = unescape(state.windows[0].extData._sm_autosave_name);
		//dump("autosave_name = " + autosave_name + "\n");
		if (autosave_name != "")
		{
			// if not recovering last session (does not including recovering last session, but selecting tabs)
			if (fileName != "*")
			{
				// Get name of chosen session
				var chosen_name = null;
				if (/^(\[SessionManager\])(?:\nname=(.*))?/m.test(this.readSessionFile(this.getSessionDir(fileName), true))) {
					chosen_name = RegExp.$2;
				}
				
				// not recovering autosave session or current session (selecting tabs), save the autosave session first
				if ((chosen_name != autosave_name) && (fileName != backupFile.leafName))
				{
					//dump("Saving crashed autosave session " + autosave_name + "\n");
					var temp_state = this.readFile(file);
					// encrypt if encryption enabled
					if (this.mPref_encrypt_sessions) {
						this.mPref_encrypted_only = this.getPref("encrypted_only", false);
						temp_state = this.decryptEncryptByPreference(temp_state);
					}
					
					if (temp_state) {
						var autosave_state = this.nameState(temp_state, autosave_name + 
						                     "\ntimestamp=" + file.lastModifiedTime + "\nautosave=session");
						this.writeFile(this.getSessionDir(this.makeFileName(autosave_name)), autosave_state);
					}
				}
				// choose to recover autosave session so just recover last session
				else 
				{
					//dump("Restoring chosen autosave session " + autosave_name + "\n");
					this.setPref("_autosave_name", autosave_name);
					if (autosave_time) this.setPref("_autosave_time", autosave_time);
					
					// if not selecting tabs, let Firefox handle the recovery, else use our backup
					if (!values.promptForTabs) {
						this.delPref("_recovering");
						params.SetInt(0, 0);
					}
					else this.setPref("_recovering", backupFile.leafName);
				}
			}
			// recovering last session
			else {
				//dump("Restoring previous session which is an autosave session named " + autosave_name + "\n");
				this.setPref("_autosave_name", autosave_name);
				if (autosave_time) this.setPref("_autosave_time", autosave_time);
			}
		}
	}
};
		
gSessionManager.restorePrompt();
window.close();
