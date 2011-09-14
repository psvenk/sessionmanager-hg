Components.utils.import("resource://sessionmanager/modules/logger.jsm");
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");

restorePrompt = function() {
	log("restorePrompt start", "INFO");
	
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
			session = gSessionManager.nameState("timestamp=" + file.lastModifiedTime + "\nautosave=false\tcount=" + count.windows + "/" + count.tabs + "\tgroup=" + gSessionManager._string("backup_sessions") + "\tscreensize=" + screensize + "\n" + state, name);
			backupFile = gSessionManager.getSessionDir(BACKUP_SESSION_FILENAME, true);
			
			if (count.windows && count.tabs) countString = count.windows + "," + count.tabs;
		}
		catch(ex) { 
			logError(ex); 
		}
	}
	
	// Don't show crash prompt if user doesn't want it.
	var show_crash_prompt = !gPreferenceManager.get("use_browser_crash_prompt", false);
	
	var params = window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock);
	params.SetInt(0, 0);
			
	var values = { name: "*", addCurrentSession: true, ignorable: false, count: countString }
	var fileName = (show_crash_prompt && location.search != "?cancel")?(gSessionManager.prompt(gSessionManager._string("recover_session"), gSessionManager._string("recover_session_ok"), values)?values.name:""):"";
	if (fileName != "*")
	{
		if (fileName)
		{
			gSessionManager._recovering = { fileName: fileName, sessionState: values.sessionState };
		}
		else if (!gPreferenceManager.get("save_window_list", false))
		{
			gSessionManager.clearUndoData("window", true);
		}
		if (show_crash_prompt) params.SetInt(0, 1); // don't recover the crashed session
	}
	
	gSessionManager.mPref["encrypt_sessions"] = gPreferenceManager.get("encrypt_sessions", false);
	// actually save the crashed session
	if (session && backupFile) {
		gSessionManager.writeFile(backupFile, session);
		gSessionManager._crash_backup_session_file = backupFile.leafName;
		if (gSessionManager.mPref["encrypt_sessions"]) gSessionManager._encrypt_file = backupFile.leafName;
	}
	
	log("restorePrompt: _encrypt_file = " + gSessionManager._encrypt_file, "DATA");
	
	// If user chose to prompt for tabs and selected a filename
	if (fileName && values.sessionState) {
		// if recovering current session, recover it from our backup file
		if (fileName == "*") {
			fileName = backupFile.leafName;
			params.SetInt(0, 1); // don't recover the crashed session
			gSessionManager._recovering = { fileName: fileName, sessionState: values.sessionState };
		}
	}
		
	log("restorePrompt: _recovering = " + (gSessionManager._recovering ? gSessionManager._recovering.fileName : "null"), "DATA");
	
	var autosave_values = gPreferenceManager.get("_autosave_values", "").split("\n");
	var autosave_filename = autosave_values[0];
	// Note that if the crashed session was an autosave session, it won't show up as a choice in the crash prompt so 
	// the user can never choose it
	if (autosave_filename)
	{
		// if not recovering last session or recovering last session, but selecting tabs, always save autosave session
		if (fileName != "*")
		{
			// delete autosave preferences
			gPreferenceManager.delete("_autosave_values");

			// Clear any stored auto save session preferences
			gSessionManager.getAutoSaveValues();
			
			log("Saving crashed autosave session " + autosave_filename, "DATA");
			var temp_state = gSessionManager.readFile(file);
			// encrypt if encryption enabled
			if (gSessionManager.mPref["encrypt_sessions"]) {
				gSessionManager.mPref["encrypted_only"] = gPreferenceManager.get("encrypted_only", false);
				temp_state = gSessionManager.decryptEncryptByPreference(temp_state);
			}
			
			if (temp_state) {
				var autosave_time = isNaN(autosave_values[3]) ? 0 : autosave_values[3];
				var autosave_state = gSessionManager.nameState("timestamp=" + file.lastModifiedTime + "\nautosave=session/" + autosave_time +
																											 "\tcount=" + count.windows + "/" + count.tabs + (autosave_values[2] ? ("\tgroup=" + autosave_values[2]) : "") +
																											 "\tscreensize=" + screensize + "\n" + temp_state, autosave_values[1]);
				gSessionManager.writeFile(gSessionManager.getSessionDir(autosave_filename), autosave_state);
			}
		}
	}
	
	// If browser is not doing the restore, save any autosave windows
	if (params.GetInt(0) == 1)
		gSessionManager._save_crashed_autosave_windows = true;

	// Don't prompt for a session again if user cancels crash prompt
	gSessionManager._no_prompt_for_session = true;
	log("restorePrompt end", "INFO");
};
		
restorePrompt();
window.close();
