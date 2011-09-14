var EXPORTED_SYMBOLS = ["gEncryptionManager"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://sessionmanager/modules/logger.jsm");
Cu.import("resource://sessionmanager/modules/session_manager.jsm");

var gEncryptionManager = {
	changeEncryption: function(aFolder) {
		gSessionManager.mEncryptionChangeInProgress = true;
		EncryptionChangeHandler.stop_processing = false;
		EncryptionChangeHandler.changeClosedWindowEncryption();
		EncryptionChangeHandler.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		// If folder passed in, use that
		if (aFolder) {
			EncryptionChangeHandler.current_folder = aFolder;
			EncryptionChangeHandler.current_cache_folder = aFolder + "/";
		}
		// If no sessions, then run finishing processing.
		if (!EncryptionChangeHandler.changeSessionEncryption())
			EncryptionChangeHandler.encryptionDone();
	},
	
	stop: function() {
		log("Encryption change interrupted, will resume next time browser is idle", "INFO");
		EncryptionChangeHandler.stop_processing = true;
	},
};
	
// This object handles the asynchronous read/writes when changing the encryption status of all session files
var EncryptionChangeHandler = {
	exception: null,
	sessions: null,
	current_filename: null,
	current_folder: null,
	current_cache_folder: "",
	changed_deleted_folder: false,
	stop_processing: false,
	timer: null,
	
	changeSessionEncryption: function() {
		// if no sessions, then this is first time run
		if (!this.sessions) {
			this.exception = null;
			this.sessions = gSessionManager.getSessions(null, this.current_folder);
			if (!this.sessions.length) {
				this.sessions = null;
				return false;
			}
			log("Encryption change running" + (this.current_folder ? (" for " + this.current_folder) : "") + ".", "TRACE");
		}
		// Get next session and read it or if no more do end processing
		let session = this.sessions.pop();
		if (session) {
			// if encryption settings don't match change encryption, else go to next file
			if (session.encrypted != gSessionManager.mPref["encrypt_sessions"]) {
				this.current_filename = session.fileName
				let file = this.current_folder ? gSessionManager.getSessionDir(this.current_folder) : gSessionManager.getSessionDir(this.current_filename);
				try {
					if (this.current_folder) file.append(this.current_filename);
					if (file.exists()) {
						gSessionManager.asyncReadFile(file,  function(aInputStream, aStatusCode) {
							EncryptionChangeHandler.onSessionFileRead(aInputStream, aStatusCode);
						});
					}
					else 
						this.processNextFile();
				}
				catch(ex) {
					this.exception = ex;
					logError("Could not change encryption for file " + this.current_filename + (this.current_folder ? (" in folder " + this.current_folder) : "") + ".");
					logError(ex);
					this.processNextFile();
				}
			}
			else 
				this.processNextFile();
		}
		else 
			this.encryptionDone();
			
		return true;
	},
	
	notify: function(timer) {
		EncryptionChangeHandler.changeSessionEncryption();
	},
	
	processNextFile: function() {
		if (!this.stop_processing)
			this.timer.initWithCallback(this, 50, Ci.nsITimer.TYPE_ONE_SHOT);
		else {
			this.encryptionDone(true);
		}
	},
	
	encryptionDone: function(aForceStop) {
		{
			if (!this.changed_deleted_folder && !aForceStop) {
				log("Encryption change complete except for deleted sessions.", "TRACE");
				// update deleted sessions as well
				this.sessions = null;
				this.current_folder = gSessionManager._string("deleted_sessions_folder");
				this.current_cache_folder = this.current_folder + "/";
				this.changed_deleted_folder = true;
				if (!this.changeSessionEncryption()) {
					this.encryptionDone();
				}
			}		
			else {
				//log("All Done with exception = " + this.exception, "INFO");
				if (!aForceStop) {
					this.sessions = null;
					this.current_filename = null;
					this.current_folder = null;
					this.current_cache_folder = "";
					this.changed_deleted_folder = false;
					if (this.exception) {
						gSessionManager.cryptError(this.exception);
						this.exception = null;
					}
				}
				
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:encryption-change", "done");
				gSessionManager.mEncryptionChangeInProgress = false;
				log("Encryption change " + (aForceStop ? "interrupted" : "complete"), "TRACE");
			}
		}
	},
	
	changeClosedWindowEncryption: function() {
		let exception = null;
		if (!gSessionManager.mUseSSClosedWindowList) {
			let windows = gSessionManager.getClosedWindows_SM();
			let okay = true;
			windows.forEach(function(aWindow) {
				aWindow.state = gSessionManager.decryptEncryptByPreference(aWindow.state, true);
				if (!aWindow.state || (typeof(aWindow.state) != "string")) {
					exception = aWindow.state;
					okay = false;
					return;
				}
			});
			if (okay) {
				gSessionManager.storeClosedWindows_SM(windows);
			}
			if (exception) gSessionManager.cryptError(exception);
		}
	},
	
	onSessionFileRead: function(aInputStream, aStatusCode) 
	{
		let need_to_process_next_file = true;
		// if read okay and is available
		if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
			// Read the file from the stream
			let is = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
			is.init(aInputStream);
			let state = is.read(aInputStream.available());
			is.close();
			aInputStream.close();
			let utf8Converter = Cc["@mozilla.org/intl/utf8converterservice;1"].getService(Ci.nsIUTF8ConverterService);
			// Sometimes this may throw with a "0x8050000e [nsIUTF8ConverterService.convertURISpecToUTF8] = <unknown>" (Antivirus maybe?) error so catch
			try {
				state = utf8Converter.convertURISpecToUTF8 (state, "UTF-8");
			}
			catch(ex) {
				// Just log as it seems the error doesn't matter, the file is still encrypted/decrypted
				logError("Error converting to UTF8 for " + this.current_filename + (this.current_folder ? (" in folder " + this.current_folder) : "") + ".");
				logError(ex);
			}
			if (state) 
			{
				try {
					state = state.replace(/\r\n?/g, "\n");
					if (SESSION_REGEXP.test(state))
					{
						state = state.split("\n")
						state[4] = gSessionManager.decryptEncryptByPreference(state[4], true);
						if (state[4] && (typeof(state[4]) == "string")) {
							state = state.join("\n");
							let file = this.current_folder ? gSessionManager.getSessionDir(this.current_folder) : gSessionManager.getSessionDir(this.current_filename);
							if (this.current_folder) file.append(this.current_filename);
							
							// copy file name and path since it can get overwritten as this is an asynchronous write
							let path = this.current_cache_folder;
							gSessionManager.writeFile(file, state, function(aResult) {
								//log("Wrote " + (path ? path : "" ) + filename, "EXTRA");
								// If write successful
								if (Components.isSuccessCode(aResult)) {
									// Update cache with new timestamp so we don't re-read it for no reason
									gSessionManager.updateCachedLastModifiedTime(path + file.leafName, file.lastModifiedTime);
								}
								EncryptionChangeHandler.processNextFile();
							});
							need_to_process_next_file = false;
						}
						else if (!this.exception)
							this.exception = state[4];
					}
				}
				catch(ex) {
					this.exception = ex;
					logError("Could not change encryption for file " + this.current_filename + (this.current_folder ? (" in folder " + this.current_folder) : "") + ".");
					logError(ex);
				}
			}
		}
		else {
			this.exception = new Components.Exception(this.current_filename, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
		}
		if (need_to_process_next_file)
			EncryptionChangeHandler.processNextFile();
		//log("Read " + (this.current_folder ? (this.current_folder + "/") : "" ) + this.current_filename, "EXTRA");
	}
};
