Components.utils.import("resource://sessionmanager/modules/logger.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");

restorePrompt = function() {
	log("restorePrompt start", "INFO");
	
	// Make sure the EOL character is set or session files will get corrupted when written
	gSessionManager.mEOL = /win|os[\/_]?2/i.test(navigator.platform)?"\r\n":/mac/i.test(navigator.platform)?"\r":"\n";
	
	// default count variable
	var countString = "";
	
	var session = null, backupFile = null, state = null, count = null;
	var	screensize = screen.width + "x" + screen.height;
			
	// Get count from crashed session and prepare to save it.  Don't save it yet or it will show up in selection list.
	var file = gSessionManager.getProfileFile("sessionstore.js");
	
	// If file does not exist, try looking for SeaMonkey's sessionstore file
	if (!file.exists()) {
		file = gSessionManager.getProfileFile("sessionstore.json");
	}
	
	if (file.exists())
	{
		try {
			var name = gSessionManager.getFormattedName("", new Date(file.lastModifiedTime), gSessionManager._string("crashed_session"));
			state = gSessionManager.readFile(file);
			count = gSessionManager.getCount(state);
			session = gSessionManager.nameState(state, name + "\ntimestamp=" + file.lastModifiedTime + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + gSessionManager._string("backup_sessions") + "\tscreensize=" + screensize);
			backupFile = gSessionManager.getSessionDir(BACKUP_SESSION_FILENAME, true);
			
			if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
		}
		catch(ex) { 
			logError(ex); 
		}
	}
	
	var params = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
	params.SetInt(0, 0);
			
	var values = { name: "*", addCurrentSession: true, ignorable: false, count: countString }
	var fileName = (location.search != "?cancel")?(gSessionManager.prompt(gSessionManager._string("recover_session"), gSessionManager._string("recover_session_ok"), values)?values.name:""):"";
	if (fileName != "*")
	{
		if (fileName)
		{
			gSessionManager._recovering =  fileName;
		}
		else if (!gSessionManager.getPref("save_window_list", false))
		{
			gSessionManager.clearUndoData("window", true);
		}
		params.SetInt(0, 1); // don't recover the crashed session
	}
	
	log("restorePrompt: _recovering = " + gSessionManager._recovering, "DATA");
	
	gSessionManager.mPref_encrypt_sessions = gSessionManager.getPref("encrypt_sessions", false);
	// actually save the crashed session
	if (session && backupFile) {
		gSessionManager.writeFile(backupFile, session);
		if (gSessionManager.mPref_encrypt_sessions) gSessionManager._encrypt_file = backupFile.leafName;
	}
	
	log("restorePrompt: _encrypt_file = " + gSessionManager._encrypt_file, "DATA");
	
	// If user chose to prompt for tabs and selected a filename
	if (fileName && values.choseTabs) {
		// if recovering current session, recover it from our backup file
		if (fileName == "*") {
			fileName = backupFile.leafName;
			params.SetInt(0, 1); // don't recover the crashed session
			gSessionManager._recovering = fileName;
		}
		gSessionManager._chose_tabs = true;
	}
		
	log("restorePrompt: _chose_tabs = " + gSessionManager._chose_tabs, "DATA");
		
	var autosave_values = gSessionManager.getPref("_autosave_values", "").split("\n");
	var autosave_name = autosave_values[0];
	if (autosave_name)
	{
		// if not recovering last session (does not including recovering last session, but selecting tabs)
		if (fileName != "*")
		{
			// Get name of chosen session
			var chosen_name = null;
			if (fileName && (/^(\[SessionManager v2\])(?:\nname=(.*))?/m.test(gSessionManager.readSessionFile(gSessionManager.getSessionDir(fileName), true)))) {
				chosen_name = RegExp.$2;
			}
			
			// not recovering autosave session or current session (selecting tabs), save the autosave session first
			if (values.choseTabs || ((chosen_name != autosave_name) && (fileName != backupFile.leafName)))
			{
				// delete autosave preferences
				gSessionManager.delPref("_autosave_values");

				// Clear any stored auto save session preferences
				gSessionManager.getAutoSaveValues();
				
				log("Saving crashed autosave session " + autosave_name, "DATA");
				var temp_state = gSessionManager.readFile(file);
				// encrypt if encryption enabled
				if (gSessionManager.mPref_encrypt_sessions) {
					gSessionManager.mPref_encrypted_only = gSessionManager.getPref("encrypted_only", false);
					temp_state = gSessionManager.decryptEncryptByPreference(temp_state);
				}
				
				if (temp_state) {
					var autosave_time = isNaN(autosave_values[2]) ? 0 : autosave_values[2];
					var autosave_state = gSessionManager.nameState(temp_state, autosave_name + 
					                     "\ntimestamp=" + file.lastModifiedTime + "\nautosave=session/" + autosave_time +
										 "\tcount=" + count.windows + "/" + count.tabs + 
										 (autosave_values[1] ? ("\tgroup=" + autosave_values[1]) : ""));
					gSessionManager.writeFile(gSessionManager.getSessionDir(gSessionManager.makeFileName(autosave_name)), autosave_state);
				}
			}
			// choose to recover autosave session so just recover last session
			else 
			{
				// we could delete the autosave preferences here, but it doesn't matter (actually it saves us from saving prefs.js file again)
				gSessionManager._recovering =  null;
				params.SetInt(0, 0);
			}
		}
	}
	
	// Don't prompt for a session again if user cancels crash prompt
	gSessionManager._no_prompt_for_session = true;
	log("restorePrompt end", "INFO");
};
		
restorePrompt();
window.close();
