gSessionManager.restorePrompt = function() {
	this.onLoad(true);
	this.onLoad = function() { };
	this.onUnload = function() { };
			
	// Delete stored autosave name by default
	this.delPref("_autosave_name");
	
	// Don't allow reloading
	this.delPref("_allow_reload");
	
	// default count variable
	var countString = "";
	
	var session = null;
	var backupFile = null;
			
	// Get count from crashed session and prepare to save it.  Don't save it yet or it will show up in selection list.
	var file = this.getProfileFile("sessionstore.js");
	if (file.exists())
	{
		try {
			var name = this.getFormattedName("", new Date(file.lastModifiedTime), this._string("crashed_session"));
			var state = this.readFile(file);
			count = this.getCount(state);
			var session = this.nameState(state, name + "\ntimestamp=" + file.lastModifiedTime + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + this._string("backup_sessions"));
			var backupFile = this.getSessionDir(this.mBackupSessionName, true);
			
			if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
		}
		catch(ex) { 
			dump(ex + "\n"); 
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
	
	// actually save the crashed session
	if (session && backupFile) {
		this.writeFile(backupFile, session);
	}
	
	// find if there was an autosave session active at time of crash and get its name
	if (/_sm_autosave_name:\"([^\s]*)\"/m.test(state))
	{
		var autosave_name = unescape(RegExp.$1);
		if (autosave_name != "")
		{
			// if not recovering last session (does not including recovering last session, but selecting tabs)
			if (fileName != "*")
			{
				// Get name of chosen session
				var chosen_name = null;
				if (/^(\[SessionManager\])(?:\nname=(.*))?/m.test(this.readSessionFile(this.getSessionDir(fileName,false), true))) {
					chosen_name = RegExp.$2;
				}
				
				// not recovering autosave session
				if (chosen_name != autosave_name)
				{
					var autosave_state = this.nameState(this.readFile(file), autosave_name + 
					                     "\ntimestamp=" + file.lastModifiedTime + "\nautosave=session");
					this.writeFile(this.getSessionDir(this.makeFileName(autosave_name), false), autosave_state);
				}
				// choose to recover autosave session so just recover last session
				else 
				{
					this.setPref("_autosave_name", autosave_name);
					
					// Let Firefox handle the recovery, else use our backup
					this.delPref("_recovering");
					params.SetInt(0, 0);
				}
			}
			// recovering last session
			else {
				this.setPref("_autosave_name", autosave_name);
			}
		}
	}
};
		
gSessionManager.restorePrompt();
window.close();
