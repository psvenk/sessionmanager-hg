var EXPORTED_SYMBOLS = ["gSessionManager", "gSQLManager", "BACKUP_SESSION_FILENAME", "SESSION_REGEXP", "STARTUP_LOAD", "STARTUP_PROMPT", 
                        "WIN_OBSERVING", "WIN_OBSERVING2", "IO_SERVICE", "OBSERVER_SERVICE", "PROMPT_SERVICE", "BACKUP_SESSION_REGEXP", 
                        "SECRET_DECODER_RING_SERVICE", "SessionStore", "WINDOW_MEDIATOR_SERVICE", "VERSION_COMPARE_SERVICE"];
						
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

//
// Constants
//
const SESSION_SQL_FILE = "sessionmanager.sqlite";
const SESSION_EXT = ".session";
const AUTO_SAVE_SESSION_REGEXP = /^autosave(-[1-9](\d)*)*\.session$/;
const BACKUP_SESSION_REGEXP = /^(backup|autosave)(-[1-9](\d)*)*\.session$/;
const AUTO_SAVE_SESSION_NAME = "autosave.session";
const SESSION_REGEXP = /^\[SessionManager v2\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session\/?\d*|window\/?\d*)\tcount=([1-9][0-9]*)\/([0-9]*)(\tgroup=([^\t\n\r]+))?(\tscreensize=(\d+)x(\d+))?/m;
const CLOSED_WINDOW_FILE = "sessionmanager.dat";
const BACKUP_SESSION_FILENAME = "backup.session";
const FIRST_URL = "http://sessionmanager.mozdev.org/history.html";
const FIRST_URL_DEV = "http://sessionmanager.mozdev.org/changelog.xhtml";
const STARTUP_PROMPT = -11;
const STARTUP_LOAD = -12;
const NO_ENCRYPT_SQL_CACHE = false;

const INVALID_FILENAMES = ["CON", "PRN", "AUX", "CLOCK$", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4",
						   "COM5", "COM6", "COM7", "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4",
						   "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

// Observers to register for once.
const OBSERVING = ["browser:purge-session-history", "quit-application-requested", "quit-application-granted", "quit-application", "private-browsing"];

// Observers to register for per window.  WIN_OBSERVING2 is for notifications that won't be removed for the last window closed
const WIN_OBSERVING = ["sessionmanager:update-undo-button", "sessionmanager:updatetitlebar", "sessionmanager:initial-windows-restored",
                       "sessionmanager:save-tab-tree-change", "sessionmanager:close-windowsession", "sessionmanager:nsPref:changed", 
                       "sessionmanager:middle-click-update", "browser:purge-session-history", "private-browsing"];
const WIN_OBSERVING2 = ["sessionmanager:process-closed-window", "quit-application-granted"];

// Get lazy getter functions from XPCOMUtils
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// import logger module
Cu.import("resource://sessionmanager/modules/logger.jsm");

// use lazy modules if available (Gecko 2.0 and up)
if (XPCOMUtils.defineLazyModuleGetter) {
	XPCOMUtils.defineLazyModuleGetter(this, "NetUtil", "resource://gre/modules/NetUtil.jsm");
	XPCOMUtils.defineLazyModuleGetter(this, "gPreferenceManager", "resource://sessionmanager/modules/preference_manager.jsm");
	XPCOMUtils.defineLazyModuleGetter(this, "PasswordManager", "resource://sessionmanager/modules/password_manager.jsm");
}
else {
	Cu.import("resource://gre/modules/NetUtil.jsm");
	Cu.import("resource://sessionmanager/modules/preference_manager.jsm");
	Cu.import("resource://sessionmanager/modules/password_manager.jsm");
}

// Get lazy references to services that will always exist, save a pointer to them so they are available during shut down.
XPCOMUtils.defineLazyServiceGetter(this, "OBSERVER_SERVICE", "@mozilla.org/observer-service;1", "nsIObserverService");
XPCOMUtils.defineLazyServiceGetter(this, "WINDOW_MEDIATOR_SERVICE", "@mozilla.org/appshell/window-mediator;1", "nsIWindowMediator");
XPCOMUtils.defineLazyServiceGetter(this, "PROMPT_SERVICE", "@mozilla.org/embedcomp/prompt-service;1", "nsIPromptService");
XPCOMUtils.defineLazyServiceGetter(this, "IO_SERVICE", "@mozilla.org/network/io-service;1", "nsIIOService");
XPCOMUtils.defineLazyServiceGetter(this, "SECRET_DECODER_RING_SERVICE", "@mozilla.org/security/sdr;1", "nsISecretDecoderRing");
XPCOMUtils.defineLazyServiceGetter(this, "VERSION_COMPARE_SERVICE", "@mozilla.org/xpcom/version-comparator;1", "nsIVersionComparator");
XPCOMUtils.defineLazyServiceGetter(this, "SCREEN_MANAGER", "@mozilla.org/gfx/screenmanager;1", "nsIScreenManager");
XPCOMUtils.defineLazyServiceGetter(this, "STORAGE_SERVICE", "@mozilla.org/storage/service;1", "mozIStorageService");
if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}
if (Cc["@mozilla.org/privatebrowsing;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "PrivateBrowsing", "@mozilla.org/privatebrowsing;1", "nsIPrivateBrowsingService");
}
else PrivateBrowsing = null;
XPCOMUtils.defineLazyGetter(this, "SM_BUNDLE", function() { return Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties"); });

// EOL Character - dependent on operating system.
var os = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime).OS;
var _EOL = /win|os[\/_]?2/i.test(os)?"\r\n":/mac|darwin/i.test(os)?"\r":"\n";
delete os;

// Other services that may or may not exist, but will be set later
var SessionStore = null;
var SessionStartup = null;

//
// private variables
//
var _number_of_windows = 0;

// This is used to fix converted sessions corrupted by 0.6.9
var _fix_newline = false;

// Time we last checked the trash folder to see if there's old sessions that can be removed
var _lastCheckedTrashForRemoval = 0;

// Temporary holder for shutdown session state
var mShutdownState = null;

// Temporary holder for profile directory
var mProfileDirectory = null;

// Cache
var mSessionCache = {};
var mClosedWindowCache = { timestamp: 0, data: null };

// SQL Cache
var SQLDataCache = [];
var SQLFileNameCache = [];
var SQLDataCacheTime = 0;
var SQLDataEncrypted = false;
var SQLDataCacheNeedsDecrypting = false;

// Flags
var convertFF3Sessions = false;
var reportedUserSessionFolderIOError = false;

var gecko2plus = false;

//
// Functions	
//

// Reference to main thread for putting up alerts when not in main thread
var mainAlertThread = function(aText) {
  this.text = aText;
};
mainAlertThread.prototype = {
	run: function() {
		PROMPT_SERVICE.alert(gSessionManager.getMostRecentWindow(), gSessionManager.mTitle, this.text);
	},
	QueryInterface: function(iid) {
		if (iid.equals(Ci.nsIRunnable) || iid.equals(Ci.nsISupports)) {
			return this;
		}
		throw Cr.NS_ERROR_NO_INTERFACE;
	}
};
						
// This function procseses read session file, it is here because it can be called as a callback function and I 
// don't want it called directly from outside this module
function getCountString(aCount) { 
	return "\tcount=" + aCount.windows + "/" + aCount.tabs + "\n"; 
};

function processReadSessionFile(state, aFile, headerOnly, aSyncCallback) {
	// old crashrecovery file format
	if ((/\n\[Window1\]\n/.test(state)) && 
		(/^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.test(state))) 
	{
		// read entire file if only read header
		let name = RegExp.$1 || gSessionManager._string("untitled_window");
		let timestamp = parseInt(RegExp.$2) || aFile.lastModifiedTime;
		if (headerOnly) state = gSessionManager.readFile(aFile);
		headerOnly = false;
		state = state.substring(state.indexOf("[Window1]\n"), state.length);
		state = gSessionManager.JSON_encode(gSessionManager.decodeOldFormat(state, true));
		let countString = getCountString(gSessionManager.getCount(state));
		state = "[SessionManager v2]\nname=" + name + "\ntimestamp=" + timestamp + "\nautosave=false" + countString + state;
		gSessionManager.writeFile(aFile, state);
	}
	// Not latest session format
	else if ((/^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n/m.test(state)) && (!SESSION_REGEXP.test(state)))
	{
		// This should always match, but is required to get the RegExp values set correctly.
		// matchArray[0] - Entire 4 line header
		// matchArray[1] - Top 3 lines (includes name and timestamp)
		// matchArray[2] - " v2" (if it exists) - if missing file is in old format
		// matchArray[3] - Autosave string (if it exists)
		// matchArray[4] - Autosave value (not really used at the moment)
		// matchArray[5] - Count string (if it exists)
		// matchArray[6] - Group string and any invalid count string before (if either exists)
		// matchArray[7] - Invalid count string (if it exists)
		// matchArray[8] - Group string (if it exists)
		// matchArray[9] - Screen size string and, if no group string, any invalid count string before (if either exists)
		// matchArray[10] - Invalid count string (if it exists)
		// matchArray[11] - Screen size string (if it exists)
		let matchArray = /(^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n)(autosave=(false|true|session\/?\d*|window\/?\d*)[\n]?)?(\tcount=[1-9][0-9]*\/[1-9][0-9]*[\n]?)?((\t.*)?(\tgroup=[^\t\n\r]+[\n]?))?((\t.*)?(\tscreensize=\d+x\d+[\n]?))?/m.exec(state)
		if (matchArray)
		{	
			// If two autosave lines, session file is bad so try and fix it (shouldn't happen anymore)
			let goodSession = !/autosave=(false|true|session\/?\d*|window\/?\d*).*\nautosave=(false|true|session\/?\d*|window\/?\d*)/m.test(state);
			
			// read entire file if only read header
			if (headerOnly) state = gSessionManager.readFile(aFile);
			headerOnly = false;

			if (goodSession)
			{
				let data = state.split("\n")[((matchArray[3]) ? 4 : 3)];
				let backup_data = data;
				// decrypt if encrypted, do not decode if in old format since old format was not encoded
				data = gSessionManager.decrypt(data, true, !matchArray[2]);
				// If old format test JSON data
				if (!matchArray[2]) {
					matchArray[1] = matchArray[1].replace(/^\[SessionManager\]/, "[SessionManager v2]");
					let test_decode = gSessionManager.JSON_decode(data, true);
					// if it failed to decode, try to decrypt again using new format
					if (test_decode._JSON_decode_failed) {
						data = gSessionManager.decrypt(backup_data, true);
					}
				}
				backup_data = null;
				if (!data) {
					// master password entered, but still could not be decrypted - either corrupt or saved under different profile
					if (data == false) {
						gSessionManager.moveToCorruptFolder(aFile);
					}
					return null;
				}
				let countString = (matchArray[5]) ? (matchArray[5]) : getCountString(gSessionManager.getCount(data));
				// If the session has no windows in it, flag it as corrupt and move it to the corrupted folder
				// if it has no closed windows otherwise make the first closed window the active window.
				// Firefox 4.0 currently can create sessions with no tabs, so don't mark those as corrupt
				if (/(0\/\d)/.test(countString)) 
				{
					// if there is a closed window in this session, make that the current window otherwise it's unrecoverable
					let decoded_data = gSessionManager.JSON_decode(data, true);
					if (decoded_data._closedWindows && decoded_data._closedWindows.length > 0) {
						decoded_data.windows = []; 
						decoded_data.windows.push(decoded_data._closedWindows.shift());
						countString = getCountString({ windows: 1, tabs: decoded_data.windows[0].tabs.length });
						data = gSessionManager.JSON_encode(decoded_data);
					}
					else {
						log("Moving to corrupt folder:" + aFile.leafName, "DATA");
						gSessionManager.moveToCorruptFolder(aFile);
						return null;
					}
				}
				// remove \n from count string if group or screen size is there
				if ((matchArray[8] || matchArray[11]) && (countString[countString.length-1] == "\n")) countString = countString.substring(0, countString.length - 1);
				let autoSaveString = (matchArray[3]) ? (matchArray[3]).split("\n")[0] : "autosave=false";
				if (autoSaveString == "autosave=true") autoSaveString = "autosave=session/";
				state = matchArray[1] + autoSaveString + countString + (matchArray[8] ? matchArray[8] : "") + (matchArray[11] ? matchArray[11] : "") + gSessionManager.decryptEncryptByPreference(data);
				gSessionManager.writeFile(aFile, state);
			}
			// else bad session format, attempt to recover by removing extra line
			else {
				let newstate = state.split("\n");
				newstate.splice(3,newstate.length - (newstate[newstate.length-1].length ? 5 : 6));
				if (RegExp.$6 == "\tcount=0/0") newstate.splice(3,1);
				state = newstate.join("\n");
				// Simply do a write and recursively proces the session again with the current state until it's correct
				// or marked as invalid.  This handles the issue with asynchronous writes.
				gSessionManager.writeFile(aFile, state);
				state = processReadSessionFile(state, aFile, headerOnly, aSyncCallback) 
			}
		}
	}
	
	// Convert from Firefox 2/3 format to 3.5+ format since Firefox 4 and later won't read the old format.  
	// Only convert if we haven't converted before.  This will only be called when
	// either caching or displaying the session list so just do a asynchronous read to do the conversion since the
	// session contents are not returned in those cases.
	if (convertFF3Sessions && state) {
		// Do an asynchronous read and then check that to prevent tying up GUI
		gSessionManager.asyncReadFile(aFile, function(aInputStream, aStatusCode) {
			if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
				// Read the session file from the stream and process and return it to the callback function
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
					// Just log as it seems the error doesn't appear to affect anything
					logError("Error converting to UTF8 for " + aFile.leafName);
					logError(ex);
				}
				if ((/,\s?\"(xultab|text|ownerURI|postdata)\"\s?:/m).test(state)) {
					try {
						state = state.replace(/\r\n?/g, "\n");
						state = gSessionManager.convertToLatestSessionFormat(aFile, state);
					}
					catch(ex) { 
						logError(ex); 
					}
				}
				// if fix new line is set fix any sessions that contain "\r\r\n"
				else if (_fix_newline) {
					if ((/\r\r+\n?/gm).test(state)) {
						log("Fixing " + aFile.leafName + " to remove extra new line characters added by version 0.6.9", "TRACE");
						state = state.replace(/\r+\n?/g, "\n").replace(/\n$/, "");
						gSessionManager.writeFile(aFile, state);
					}
				}
			}
		});
	}
	
	return state;
}

// 
// SQL Manager exported object - Move this to it's own module file once cross dependencies are resolved
var gSQLManager = {
	// Reads the passed session or all session files and builds or updates an SQL cache of those sessions windows and tabs.
	// aSessionFileName can be either a string or an array of strings.
	addSessionToSQLCache: function(aDeleteFirst, aSessionFileName) {
		if (!gSessionManager.mPref["use_SQLite_cache"])
			return;

		if (gSessionManager.mPref["encrypt_sessions"] && !PasswordManager.enterMasterPassword()) {
			gSessionManager.cryptError(gSessionManager._string("encryption_sql_failure"));
			return true;
		}

		log("Caching " + (aSessionFileName ? JSON.stringify(aSessionFileName) : "all sessions") + " into SQL file.", "INFO");
		
		let date = new Date();
		let begin = date.getTime();

		let regexp = null;
		if (aSessionFileName) {
			// build regular expression, escaping all special characters
			let escaped_name;
			// Array.isArray is Gecko 2 or higher, for Firefox 3.6 check for type of object which may or may not be an array.
			if ((Array.isArray && Array.isArray(aSessionFileName)) || (!Array.isArray && (typeof aSessionFileName == "object"))) {
				for (var i=0; i<aSessionFileName.length; i++)
					escaped_name = (i != 0) ? ("|" + aSessionFileName[i]) : aSessionFileName;
			}
			else if (typeof (aSessionFileName) == "string") 
				escaped_name = aSessionFileName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
				
			regexp = new RegExp("^" + escaped_name + "$");
		}
		let sessions = gSessionManager.getSessions(regexp,null,true);
		let sessionData = [], fileNames = [];

		let mDBConn, statement, params;
		if (sessions.length) {
			// create or open the SQL cache file
			mDBConn = this.getSQLDataBase(aDeleteFirst);
			if (!mDBConn)
				return;
			
			// Add or update existing values
			statement = mDBConn.createStatement(
				"INSERT OR REPLACE INTO sessions (filename, name, groupname, timestamp, autosave, windows, tabs, backup, state) " +
				"VALUES ( :filename, :name, :groupname, :timestamp, :autosave, :windows, :tabs, :backup, :state )"
			);
			params = statement.newBindingParamsArray();
		}
		
		var statement_callback = {
			handleResult: function(aResultSet) {
			},

			handleError: function(aError) {
				log("Error adding to or updating SQL cache file", "ERROR");
				logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
					logError("Creation/update of SQL cache file canceled or aborted!");
					
				// aSyncClose only exists in Firefox 4 and higher (not 3.6) so do a close here in Firefox 3.6
				if (!gecko2plus)
					mDBConn.close();
					
				let date = new Date();
				let end = date.getTime();
				log("Cached " + (aSessionFileName ? JSON.stringify(aSessionFileName) : "all sessions") + " into SQL file in " + (end - begin) + " ms", "INFO");
				
				// Cache added tab data to memory by searching the current cache data and updating it and then adding anything left
				let index;
				for (var i=0; i<SQLDataCache.length; i++) {
					if ((index = fileNames.indexOf(SQLDataCache[i].fileName)) != -1) {
						SQLDataCache[i] = sessionData.splice(index, 1)[0];
						fileNames.splice(index, 1);
					}
				}
				sessionData.forEach(function(tab) {
					SQLDataCache.push(tab);
					SQLFileNameCache.push(tab.fileName);
				});
				// Get a new file handler since lastModifiedTime will be the time when the file was opened.
				let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
				file.append(SESSION_SQL_FILE);
				SQLDataCacheTime = file.lastModifiedTime;
				SQLDataEncrypted = gSessionManager.mPref["encrypt_sessions"];

				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:sql-cache-updated", aSessionFileName);
			}
		}
		
		var timer_callback = {
			timer: null,
			found_session: false,
			notify: function(timer) {
				let session;
				try {
					session = sessions.pop();
				}
				catch(ex) { 
					logError(ex);
					session = null;
				};
				if (session) {
					let file = gSessionManager.getSessionDir(session.fileName);
					// read session files without doing extra processing (faster)
					let state = gSessionManager.readSessionFile(file, false, null, true)
					if (state) 
						if (SESSION_REGEXP.test(state))
							state = state.split("\n")
					
					if (state[4]) {
						let data = gSQLManager.getWindowAndTabData(state[4]);
						if (data) {
							this.found_session = true;
							let tab_data = gSessionManager.JSON_encode(data);
							// Just replace whatever's there since the filename is unique
							let bp = params.newBindingParams();
							bp.bindByName("filename", session.fileName);
							bp.bindByName("name", session.name);
							bp.bindByName("groupname", session.group);
							bp.bindByName("timestamp", session.timestamp);
							bp.bindByName("autosave", session.autosave);
							bp.bindByName("windows", session.windows);
							bp.bindByName("tabs", session.tabs);
							bp.bindByName("backup", session.backup ? 1 : 0);
							// ENCRYPTING SLOWS THINGS DOWN EXPONENTIALLY
							bp.bindByName("state", NO_ENCRYPT_SQL_CACHE ? tab_data : gSessionManager.decryptEncryptByPreference(tab_data, true, true));
							params.addParams(bp);
							
							sessionData.push({ fileName: session.fileName, name: session.name, groupname: session.group, timestamp: session.timestamp,
							                   autosave: session.autosave, windows: session.windows, tabs: session.tabs, backup: (session.backup ? 1 : 0),
																 state: tab_data });
							
							// store values to add to memory cache later, use separate filename array to make searching easier.
							fileNames.push(session.fileName);
						}
					}
				}
				else {
					this.timer.cancel();
					this.timer = null;
					if (this.found_session) {
						statement.bindParameters(params);
						statement.executeAsync(statement_callback);
					}
					statement.finalize();
					// aSyncClose only exists in Firefox 4 and higher (not 3.6)
					if (gecko2plus)
						mDBConn.asyncClose();
				}
			}
		}
		
		if (sessions.length) {
			// Use a timer to prevent GUI lockup which can occur when processing a lot of data (especially encrypted data)
			timer_callback.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			timer_callback.timer.initWithCallback(timer_callback, (gSessionManager.mPref["encrypt_sessions"] ? 100 : 50), Ci.nsITimer.TYPE_REPEATING_SLACK);
		}
		else
			this.removeSessionFromSQLCache(aSessionFileName)
	},
	
	// Change encryption for SQL cache
	changeEncryptionSQLCache: function(aTabData, aFileNames, aFailedToDecrypt, aIsThereAnyEncryptedData, aIsPartiallyEncrypted) {
		if (!gSessionManager.mPref["use_SQLite_cache"] || NO_ENCRYPT_SQL_CACHE)
			return;

		if (!aTabData) {
		
			// force a master password prompt so we don't waste time if user cancels it
			if (!PasswordManager.enterMasterPassword()) 
			{
				gSessionManager.cryptError(gSessionManager._string("encryption_sql_failure"));
				return;
			}
		
			let date = new Date();
			this.begin = date.getTime();
			gSQLManager.readSessionDataFromSQLCache(gSQLManager.changeEncryptionSQLCache);
		}
		else {
			// If already in correct encryption state or decryption failed, exit
			if (aFailedToDecrypt)
				return
				
			if (!aIsPartiallyEncrypted && (aIsThereAnyEncryptedData == gSessionManager.mPref["encrypt_sessions"]))
				return;
	
			let mDBConn = gSQLManager.getSQLDataBase();
			if (!mDBConn)
				return;

			let statement = mDBConn.createStatement(
				"INSERT OR REPLACE INTO sessions (filename, name, groupname, timestamp, autosave, windows, tabs, backup, state) " +
				"VALUES ( :filename, :name, :groupname, :timestamp, :autosave, :windows, :tabs, :backup, :state )"
			);
			
			let params = statement.newBindingParamsArray();

			var statement_callback = {
				handleResult: function(aResultSet) {
				},

				handleError: function(aError) {
					log("Error changing encryption of SQL cache file", "ERROR");
					logError(aError);
				},

				handleCompletion: function(aReason) {
					if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
						logError("Changing encryption of SQL cache file canceled or aborted!");
					let date = new Date();
					let end = date.getTime();
					log("Encryption change of SQL file took " + (end - gSQLManager.begin) + " ms", "INFO");
					// Get a new file handler since lastModifiedTime will be the time when the file was opened.
					let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
					file.append(SESSION_SQL_FILE);
					SQLDataCacheTime = file.lastModifiedTime;
					SQLDataEncrypted = gSessionManager.mPref["encrypt_sessions"];
					
					// aSyncClose only exists in Firefox 4 and higher (not 3.6) so do a close here in Firefox 3.6
					if (!gecko2plus)
						mDBConn.close();
				}
			};
			
			// Get new timestamps
			let timestamps = [];
			let sessions = gSessionManager.getSessions();
			sessions.forEach(function(aSession) {
				timestamps[aSession.fileName] = aSession.timestamp;
			});
			
			var timer_callback = {
				timer: null,
				found_session: false,
				notify: function(timer) {
					let data;
					try {
						data = aTabData.pop();
					}
					catch(ex) { 
						logError(ex);
						data = null;
					};
					if (data) {
						// Just replace whatever's there since the filename is unique
						let bp = params.newBindingParams();
						bp.bindByName("filename", data.fileName);
						bp.bindByName("name", data.name);
						bp.bindByName("groupname", data.group);
						bp.bindByName("timestamp", timestamps[data.fileName]);
						bp.bindByName("autosave", data.autosave);
						bp.bindByName("windows", data.windows);
						bp.bindByName("tabs", data.tabs);
						bp.bindByName("backup", data.backup);
						bp.bindByName("state", gSessionManager.decryptEncryptByPreference(data.state, true, true));
						params.addParams(bp);
						this.found_session = true;
					}
					else {
						this.timer.cancel();
						this.timer = null;
						if (this.found_session) {
							statement.bindParameters(params);
							statement.executeAsync(statement_callback);
						}
						statement.finalize();
						// aSyncClose only exists in Firefox 4 and higher (not 3.6)
						if (gecko2plus)
							mDBConn.asyncClose();
					}
				}
			}
			
			// Use a timer to prevent GUI lockup which can occur when processing a lot of data (especially encrypted data)
			timer_callback.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			timer_callback.timer.initWithCallback(timer_callback, (gSessionManager.mPref["encrypt_sessions"] ? 100 : 50), Ci.nsITimer.TYPE_REPEATING_SLACK);
		}
	},
	
	// verify that SQL cache is not corrupt, if it is rebuild it.  If it's not
	// continue to checkSQLCache2 which will verify data is up to date and that
	// there isn't an encryption/decryption mismatch.
	checkSQLCache: function() {
		log("Checking SQL Cache integrity and freshness", "INFO");
	
		let mDBConn = this.getSQLDataBase();
		if (!mDBConn) {
			logError("SQL Database corrupt, rebuilding");
			this.updateSQLCache(true);
			return;
		}
		
		// Do an integrity check, if fail re-create database
		let statement = mDBConn.createStatement("PRAGMA integrity_check");
		statement.executeAsync({
			results: "",
		
			handleResult: function(aResultSet) {
				for (let row = aResultSet.getNextRow(); row; row = aResultSet.getNextRow()) {
					this.results = row.getResultByIndex(0);
				}
			},

			handleError: function(aError) {
					log("Error checking integrity of SQL", "ERROR");
					logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
					logError("Integrity check of SQL canceled or aborted!");
				log("Integrity check of SQL cache done.", "INFO");
				// aSyncClose only exists in Firefox 4 and higher (not 3.6) so do a close here in Firefox 3.6
				if (!gecko2plus)
					mDBConn.close();
				
				// If not okay, rebuild SQL database, otherwise check to see if number of sessions match
				if (this.results != "ok") {
					logError("SQL Database corrupt, rebuilding");
					gSQLManager.updateSQLCache(true);
				}
				else {
					try {
						gSQLManager.readSessionDataFromSQLCache(gSQLManager.checkSQLCache2, null, true);
					}
					catch(ex) {
						logError("SQL Database corrupt, rebuilding");
						gSQLManager.updateSQLCache(true);
					}
				}
			}
		});
		statement.finalize();
		// aSyncClose only exists in Firefox 4 and higher (not 3.6)
		if (gecko2plus)
			mDBConn.asyncClose();
	},

	checkSQLCache2: function(aTabData, aFileNames, aFailedToDecrypt, aIsThereAnyEncryptedData, aIsPartiallyEncrypted) {
		// This should never happen since we can't fail when checking for partial encryption, but check anyway in case I change it in future.
		if (aFailedToDecrypt)
			return;
	
		// See if there's any updated, missing or extra sessions
		let sessions = gSessionManager.getSessions();
		let index, filename, filenames_of_updated_sessions = [], filenames_of_existing_sessions = [];
		// Loop through all the current sessions and mark any missing sessions or ones with
		// mismatched timestamps as needing to be updated (or added). 
		for (var i=0; i<sessions.length; i++) {
			// Create list of filenames that exist
			filenames_of_existing_sessions.push(sessions[i].fileName);
			
			// found session in both SQL file and sessions folder
			if ((index = aFileNames.indexOf(sessions[i].fileName)) != -1) {
				// timestamps don't match so needs updating.
				if (aTabData[index].timestamp != sessions[i].timestamp)
					filenames_of_updated_sessions.push(aFileNames[index]);
			}
			else
				filenames_of_updated_sessions.push(sessions[i].fileName);
		}

		// Remove all filenames that are in aFilesNames, but not in filenames_of_existing_sessions (i.e. don't exist)
		let filenames_of_removed_sessions = aFileNames.filter(function(aFileName) {
			return (filenames_of_existing_sessions.indexOf(aFileName) == -1);
		});
		
		log("Adding/Updating: " + filenames_of_updated_sessions, "EXTRA");
		log("Removing: " + filenames_of_removed_sessions, "EXTRA");
		
		if (filenames_of_updated_sessions.length)
			gSQLManager.addSessionToSQLCache(false, filenames_of_updated_sessions);
		// At this point anything left in aFileNames are sessions that don't exist and can be removed.
		if (filenames_of_removed_sessions.length) 
			gSQLManager.removeSessionFromSQLCache(filenames_of_removed_sessions);
		
		// If there's an encryption mismatch, fix that now
		if (aIsPartiallyEncrypted || (aIsThereAnyEncryptedData != gSessionManager.mPref["encrypt_sessions"])) {
			log("SQL cache encryption doesn't match encryption setting, fixing", "INFO");
			gSQLManager.changeEncryptionSQLCache();
		}
		
		// Compact and reindex the SQL file now as well to keep things quick.
		gSQLManager.vacuumSQLCache();
	},
	
	getSQLDataBase: function(aDeleteFirst) {
		// Open SQL file and connect to it
		let file = Cc["@mozilla.org/file/directory_service;1"]
							 .getService(Ci.nsIProperties)
							 .get("ProfD", Ci.nsIFile);
		file.append(SESSION_SQL_FILE);
		
		let already_exists = file.exists();
		if (already_exists && aDeleteFirst)
			gSessionManager.delFile(file, false, true);

		let mDBConn = null;
		try {
			mDBConn = STORAGE_SERVICE.openDatabase(file); 
		}
		catch(ex) {
			gSessionManager.ioError(ex, SESSION_SQL_FILE);
			return false;
		}
		
		if (!already_exists || aDeleteFirst) {
			// Grow in increments of 1 MB.  Option not available in Firefox 3.6
			if (gecko2plus)
				mDBConn.setGrowthIncrement(1 * 1024 * 1024, "");

			try {
				mDBConn.createTable("sessions", "filename TEXT PRIMARY KEY, name TEXT, groupname TEXT, timestamp INTEGER," +
														"autosave TEXT, windows INTEGER, tabs INTEGER, backup INTEGER, state BLOB");
			}
			catch(ex) {
				gSessionManager.ioError(ex, SESSION_SQL_FILE);
			}
		}
		
		return mDBConn;
	},
			
	// Giving state data returns an objec containing the Tab titles and and URLs
	getWindowAndTabData: function(aState) {
		let sessionData = [];
		let data_found = false;
		let state = gSessionManager.decrypt(aState, true);
		if (state) {
			state = gSessionManager.JSON_decode(state, true);
			if (!state._JSON_decode_failed) {
				// Loop windows
				state.windows.forEach(function(aWindow, aIx) {
					let tabData = [];

					// Try to find tab group nanes if they exists, 0 is the default group and has no name
					var tab_groups = { 0:"" };
					if (aWindow.extData && aWindow.extData["tabview-group"]) {
						var tabview_groups = gSessionManager.JSON_decode(aWindow.extData["tabview-group"], true);
						if (tabview_groups && !tabview_groups._JSON_decode_failed) {
							for (var id in tabview_groups) {
								tab_groups[id] = tabview_groups[id].title;
							}
						}
					}
					
					// Loop tabs
					aWindow.tabs.forEach(function(aTab) {
						// Add tabs that have at least one valid entry
						let index = parseInt(aTab.index) - 1;

						// Try to find tab group ID if it exists, 0 is default group
						var groupID = 0;
						if (aTab.extData && aTab.extData["tabview-tab"]) {
							var tabview_data = gSessionManager.JSON_decode(aTab.extData["tabview-tab"], true);
							if (tabview_data && !tabview_data._JSON_decode_failed) 
								groupID = tabview_data.groupID;
						}

						// This includes all tab history entries
						if (aTab.entries) {
							let history = [];
							aTab.entries.forEach(function(aEntry, aIndex) {
								history.push({ title: (aEntry.title ? aEntry.title : "about:blank"), url: (aEntry.url ? aEntry.url : "about:blank"), current: (index == aIndex)});
							});
							// If no history, then just add a blank tab 
							if (!history.length) {
								history.push({ title: "about:blank", url: "about:blank", current: true });
							}
							tabData.push({ history: history, index: (isNaN(index) ? "0" : index), hidden: aTab.hidden,
														 tab_group_id: groupID, tab_group_name: ((tab_groups[groupID]) || groupID || "") });
							data_found = true;
						}
					});
					sessionData.push({ tab_groups: tab_groups, tabData: tabData });
				});
			}
		}
		return data_found ? sessionData : null;
	},

	// Read the cache file (if it exists) and call the callback function with the results
	// Returns true if cache file exists or false otherwise
	readSessionDataFromSQLCache: function(aCallback, aSessionFileName, aCheckForPartialEncryption) {
		// Open SQL file and connect to it
		let file = Cc["@mozilla.org/file/directory_service;1"]
							 .getService(Ci.nsIProperties)
							 .get("ProfD", Ci.nsIFile);
		file.append(SESSION_SQL_FILE);
		
		// If the file doesn't exist just exit.
		if (!file.exists())
			return false;
			
		// If data is cached and requesting all sessions, just return that
		if (SQLDataCacheTime == file.lastModifiedTime) {
			let failed_decryption = SQLDataCacheNeedsDecrypting;
			let index = SQLFileNameCache.indexOf(aSessionFileName);
			
			// If cached data is encrypted, decrypt it
			if (SQLDataCacheNeedsDecrypting) {
				if (!aSessionFileName || (index != -1)) {
					if (PasswordManager.enterMasterPassword()) {
						if (index != -1) 
							SQLDataCache[index].state = gSessionManager.decrypt(SQLDataCache[index].state, true);
						else {
							for (var i=0; i<SQLDataCache.length; i++) {
								SQLDataCache[i].state = gSessionManager.decrypt(SQLDataCache[i].state, true);
							}
						}
						failed_decryption = false;
						// Mark file as not needing decryption if decrypted all sessions
						if (!aSessionFileName)
							SQLDataCacheNeedsDecrypting = false;
					}
					else
						gSessionManager.cryptError(gSessionManager._string("encryption_sql_failure"));
				}
			}
			log("Returning cached SQL cache data" + (aSessionFileName ? (" for " + aSessionFileName) : "."), "EXTRA");
			if (typeof aCallback == "function") {
				// Need to use a global variable to prevent timer from being garbage collected which will stop timer
				let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				timer.initWithCallback(function() {
					// Make a copy of the cached data or it might get changed which would be bad
					aCallback(aSessionFileName ? (index != -1 ? [SQLDataCache[index]] : []) : SQLDataCache.slice(), 
					          aSessionFileName ? (index != -1 ? [SQLFileNameCache[index]] : []) : SQLFileNameCache.slice(), 
					          failed_decryption, SQLDataEncrypted);
				}, 0, Ci.nsITimer.TYPE_ONE_SHOT);
			}
		}	
		else {
			let mDBConn
			try {
				mDBConn = STORAGE_SERVICE.openDatabase(file); 
			}
			catch(ex) {
				gSessionManager.ioError(ex, SESSION_SQL_FILE);
				return false;
			}
		
			// Select all rows, but remove duplicates.  There shouldn't be any dupes, but this also orders the results
			let statement = mDBConn.createStatement("SELECT ALL * FROM sessions" + (aSessionFileName ? " WHERE filename = :name" : ""));
			if (aSessionFileName)
				statement.params.name = aSessionFileName;
			
			statement.executeAsync({
				tabData: [], 
				fileNames: [],
				
				// When checking for partial encryption at startup we don't want to needlessly through up the password
				// prompt since we don't really care about the data itself.  So just return the encrypted data at that point.
				// Make sure not to cache it though.
				
				// Results come in multiple times per statement so store all the tab data until complete.  Attempting
				// to do any processing in here which prompts the user will result in handleCompletion firing before
				// handleResult exits, so just store all the data as is and do encryption processing in handleCompletion.
				handleResult: function(aResultSet) {
					for (let row = aResultSet.getNextRow(); row; row = aResultSet.getNextRow()) {
						this.tabData.push({ fileName: row.getResultByName("filename"), name: row.getResultByName("name"),
													 group: row.getResultByName("groupname"), timestamp: row.getResultByName("timestamp"),
													 autosave: row.getResultByName("autosave"), windows: row.getResultByName("windows"),
													 tabs: row.getResultByName("tabs"), backup: row.getResultByName("backup"),
													 state: row.getResultByName("state")});
						this.fileNames.push(row.getResultByName("filename"));
					}
				},

				handleError: function(aError) {
						log("Error reading session data from SQL file", "ERROR");
						logError(aError);
				},

				handleCompletion: function(aReason) {
					// aSyncClose only exists in Firefox 4 and higher (not 3.6) so do a close here in Firefox 3.6
					if (!gecko2plus)
						mDBConn.close();
						
					if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED) {
						logError("Reading from SQL file canceled or aborted!");
						return;
					}
					else
						log("Reading from SQL cache file done" + (aSessionFileName ? (" for " + aSessionFileName) : "."), "INFO");
						
					var do_not_decrypt = aCheckForPartialEncryption && PasswordManager.isMasterPasswordRequired();

					// Do encryption handling here.  It's less efficient, but it's the only thing that works
					let data_encrypted = null, partial_encryption = false;
					let checked_master_password = false, failed_to_decrypt = false;
					for (var i=0; i<this.tabData.length; i++) {
						// if checking for partial encryption, stop checking once we that it's partially encrypted
						if (aCheckForPartialEncryption && !partial_encryption) {
							let old_data_encrypted = data_encrypted;
							data_encrypted = data_encrypted || (this.tabData[i].state.indexOf(":") == -1);
							if ((old_data_encrypted != null) && (old_data_encrypted != data_encrypted)) {
								partial_encryption = true;
							}
						}
						else
							data_encrypted = data_encrypted || (this.tabData[i].state.indexOf(":") == -1);
							
						// If data is encrypted and not simply checking cache, prompt for master password once. If user cancels, give up
						if (data_encrypted && !do_not_decrypt) {
							if (!checked_master_password) {
								checked_master_password = true;
								if (!PasswordManager.enterMasterPassword()) {
									gSessionManager.cryptError(gSessionManager._string("encryption_sql_failure"));
									failed_to_decrypt = true;
									break;
								}
							}
							this.tabData[i].state = gSessionManager.decrypt(this.tabData[i].state, true);
						}
					}
					
					log("Caching results", "TRACE");
					if (!aSessionFileName) {
						SQLDataCache = this.tabData;
						SQLFileNameCache = this.fileNames;
						SQLDataEncrypted = data_encrypted;
						SQLDataCacheNeedsDecrypting = data_encrypted && (failed_to_decrypt || do_not_decrypt);
					}
					else {
						let found_session = false;
						for (var i=0; i<SQLDataCache.length; i++) {
							if (SQLFileNameCache[i] == aSessionFileName) {
								SQLDataCache[i]= this.tabData[0];
								break;
							}
						}
						if (!found_session)
							SQLDataCache.push(this.tabData[0])
							SQLFileNameCache.push(aSessionFileName);
					}
					SQLDataCacheTime = file.lastModifiedTime;
					
					// Send the results to caller if callback requested (use slice so cache doesn't get modified if user changes values)
					if (typeof aCallback == "function") 
						aCallback(this.tabData.slice(), this.fileNames.slice(), failed_to_decrypt, data_encrypted, partial_encryption);
				}
			});			
			
			statement.finalize();
			// aSyncClose only exists in Firefox 4 and higher (not 3.6)
			if (gecko2plus)
				mDBConn.asyncClose();
		}
		return true;
	},
	
	// aSessionFileName can be either a string or an array of strings.
	removeSessionFromSQLCache: function(aSessionFileName) {
		// Open SQL file and connect to it
		let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
		file.append(SESSION_SQL_FILE);
		
		// If the file doesn't exist just exit.
		if (!file.exists())
			return;
			
		if (!aSessionFileName) {
			gSessionManager.delFile(file, true, true);
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:sql-cache-updated", aSessionFileName);
		}
		else {
			let mDBConn
			try {
				mDBConn = STORAGE_SERVICE.openDatabase(file); 
			}
			catch(ex) {
				gSessionManager.ioError(ex, SESSION_SQL_FILE);
				return;
			}
		
			let statement = mDBConn.createStatement("DELETE FROM sessions WHERE filename = :filename");
			let array_of_filenames = false;
			if ((Array.isArray && Array.isArray(aSessionFileName)) || (!Array.isArray && (typeof aSessionFileName == "object"))) {
				array_of_filenames = true;
				let params = statement.newBindingParamsArray();
				for (var i=0; i<aSessionFileName.length; i++) {
					let bp = params.newBindingParams();
					bp.bindByName("filename", aSessionFileName[i]);
					params.addParams(bp);
				}
				statement.bindParameters(params);
			}
			else if (typeof (aSessionFileName) == "string") 
				statement.params.filename = aSessionFileName;
			
			statement.executeAsync({
				handleResult: function(aResultSet) {
				},

				handleError: function(aError) {
						log("Error deleting session from SQL", "ERROR");
						logError(aError);
				},

				handleCompletion: function(aReason) {
					if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
						logError("Deleteing from SQL canceled or aborted!");
						
					// aSyncClose only exists in Firefox 4 and higher (not 3.6) so do a close here in Firefox 3.6
					if (!gecko2plus)
						mDBConn.close();
						
					log("Delete from SQL cache done for " + JSON.stringify(aSessionFileName), "INFO");
					
					let removed_item = false;
					// Remove deleted item from memory cache
					let i=0;
					while (i<SQLDataCache.length) {
						if ((!array_of_filenames && (SQLDataCache[i].fileName == aSessionFileName)) || (array_of_filenames && (aSessionFileName.indexOf(SQLDataCache[i].fileName) != -1))) {
							SQLDataCache.splice(i, 1);
							SQLFileNameCache.splice(i, 1);
							removed_item = true;
							if (!array_of_filenames)
								break;
						}
						else
							i++;
					}

					if (removed_item) {
						// Get a new file handler since lastModifiedTime will be the time when the file was opened.
						let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
						file.append(SESSION_SQL_FILE);
						SQLDataCacheTime = file.lastModifiedTime;
					}
						
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:sql-cache-updated", aSessionFileName);
				}
			});			
			
			statement.finalize();
			// aSyncClose only exists in Firefox 4 and higher (not 3.6)
			if (gecko2plus)
				mDBConn.asyncClose();
		}
	},

	updateSQLCache: function(aDeleteFirst, aCreateOnly) {
		let doUpdate = true;
		if (aCreateOnly) {
			// Open SQL file and connect to it
			let file = Cc["@mozilla.org/file/directory_service;1"]
								 .getService(Ci.nsIProperties)
								 .get("ProfD", Ci.nsIFile);
			file.append(SESSION_SQL_FILE);
			doUpdate = !file.exists();
		}
		if (doUpdate)
			this.addSessionToSQLCache(aDeleteFirst, null);
			
		return doUpdate;
	},

	// compact and reindex database to keep things quick
	vacuumSQLCache: function()
	{
		// Open SQL file and connect to it
		let mDBConn = this.getSQLDataBase();
		if (!mDBConn)
			return;
		
		let statement = mDBConn.createStatement("VACUUM; REINDEX");
		statement.executeAsync({
			handleResult: function(aResultSet) {
			},

			handleError: function(aError) {
					log("Error vaccuming SQL file", "ERROR");
					logError(aError);
			},

			handleCompletion: function(aReason) {
				if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
					logError("Vacuuming SQL canceled or aborted!");
				// aSyncClose only exists in Firefox 4 and higher (not 3.6) so do a close here in Firefox 3.6
				if (!gecko2plus)
					mDBConn.close();
					
				// Get a new file handler since lastModifiedTime will be the time when the file was opened.
				let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
				file.append(SESSION_SQL_FILE);
				SQLDataCacheTime = file.lastModifiedTime;
			}
		});			
		statement.finalize();
		
		// aSyncClose only exists in Firefox 4 and higher (not 3.6)
		if (gecko2plus)
			mDBConn.asyncClose();
	},
};

//
// The main exported object
//
var gSessionManager = {
	// private temporary values
	_initialized: false,
	_encrypt_file: null,
	_no_prompt_for_session: false,
	_recovering: null,
	_temp_restore: null,
	_save_crashed_autosave_windows: false,
	_crash_backup_session_file: null,
	_crash_session_filename: null,
	_restoring_autosave_backup_session: false,
	_restoring_backup_session: false,
	_pb_saved_autosave_values: null,
	
	// Used to indicate whether or not saving tab tree needs to be updated
	savingTabTreeVisible: false,
	
	// Timers
	_autosave_timer : null,
	_backup_timer : null,
	
	// Session Prompt Data
	sessionPromptData: null,
	sessionPromptReturnData: null,
	
	// Shared data
	_browserWindowDisplayed: false,
	_countWindows: true,
	_displayUpdateMessage: null,
	mActiveWindowSessions: [],
	mAlreadyShutdown: false,
	mAutoPrivacy: false,
	mBackupState: null,
	mEncryptionChangeInProgress: false,
	mPlatformVersion: 0,
	mShutdownPromptResults: -1,
	mPref: {},
	// Temporary holder for last closed window's state value
	mClosingWindowState: null,
	// This formced window sessions to save and stay open.  It gets set when about to enter private browsing mode upon the
	// "private-browsing-change-granted" notification to allow windows to be saved since the isPrivateBrowserMode() function will return
	// true at that point, even though the browser technically is not in private browsing.  The flag is immediately cleared after the
	// windows are saved. 
	mAboutToEnterPrivateBrowsing: false,
	
	// Flags
	tabMixPlusEnabled: false,
	
	// Callback used to get extensions in Firefox 4.0 and higher
	getExtensionsCallback: function(extensions) {
		try {
			gSessionManager.checkForUpdate(extensions);
		}
		catch(ex) { logError(ex); }
	},
	
	// Check for updated version and make any required changes
	checkForUpdate: function(extensions) {
		// Set a flag indicating whether or not Tab Mix Plus is active.
		let tabMixPlus = extensions.get("{dc572301-7619-498c-a57d-39143191b318}");
		this.tabMixPlusEnabled = tabMixPlus && tabMixPlus.enabled;
		// this is needed in case windows open before this value is set.
		OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:middle-click-update", null);
	
		let oldVersion = gPreferenceManager.get("version", "");
		let newVersion = extensions.get("{1280606b-2510-4fe0-97ef-9b5a22eafe30}").version;
		if (oldVersion != newVersion)
		{
			// Fix the closed window data if it's encrypted
			if ((VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.4.2") < 0) && !this.mUseSSClosedWindowList) {
				// if encryption enabled
				if (this.mPref["encrypt_sessions"]) {
					let windows = this.getClosedWindows_SM();
					
					// if any closed windows
					if (windows.length) {
						// force a master password prompt so we don't waste time if user cancels it, if user cancels three times 
						// simply delete the stored closed windows
						let count = 4;
						while (--count && !PasswordManager.enterMasterPassword());

						let okay = true;
						let exception = null;
						if (count) {
							windows.forEach(function(aWindow) {
								aWindow.state = this.decrypt(aWindow.state, true, true);
								aWindow.state = this.decryptEncryptByPreference(aWindow.state, true);
								if (!aWindow.state || (typeof(aWindow.state) != "string")) {
									okay = false;
									exception = aWindow.state;
									return;
								}
							}, this);
							if (okay) {
								this.storeClosedWindows_SM(windows);
							}
						}
						else {
							okay = false;
						}
						if (!okay) {
							if (exception) this.cryptError(exception, true);
							// delete closed windows
							this.storeClosedWindows_SM([]);
						}
					}
				}
			}

			// these aren't used anymore
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.2.5") < 0) gPreferenceManager.delete("_no_reload");
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.7.6") < 0) gPreferenceManager.delete("disable_cache_fixer");
			
			// This preference is no longer a boolean so delete it when updating to prevent exceptions.
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.7.7pre20110824") <= 0) gPreferenceManager.delete("leave_prompt_window_open");
			
			// Cached data changed (now cache history) so re-create cache file if enabled
			if ((VERSION_COMPARE_SERVICE.compare(oldVersion, "0.7.7pre20110826") <= 0) && (this.mPref["use_SQLite_cache"])) 
				gSQLManager.updateSQLCache(true);

			// Clean out screenX and screenY persist values from localstore.rdf since we don't persist anymore.
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.2.1") < 0) {
				let RDF = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
				let ls = Cc["@mozilla.org/rdf/datasource;1?name=local-store"].getService(Ci.nsIRDFDataSource);
				let rdfNode = RDF.GetResource("chrome://sessionmanager/content/options.xul#sessionmanagerOptions");
				let arcOut = ls.ArcLabelsOut(rdfNode);
				while (arcOut.hasMoreElements()) {
					let aLabel = arcOut.getNext();
					if (aLabel instanceof Ci.nsIRDFResource) {
						let aTarget = ls.GetTarget(rdfNode, aLabel, true);
						ls.Unassert(rdfNode, aLabel, aTarget);
					}
				}
				ls.QueryInterface(Ci.nsIRDFRemoteDataSource).Flush();
			}
						
			// Add backup sessions to backup group
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.2.8") < 0) {
				let sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (aSession.backup) {
						this.group(aSession.fileName, this._string("backup_sessions"));
					}
				}, this);
			}
			
			// Version 0.6.9 had a bug in it which would corrupt old session format files so fix them.
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.9") == 0) {
				_fix_newline = true;
				convertFF3Sessions = true;
			}
			
			// New version doesn't automatically append "sessions" to user chosen directory so
			// convert existing preference to point to that folder.
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.7") < 0) {
				if (gPreferenceManager.get("sessions_dir", null)) {
					let dir = this.getUserDir("sessions");
					gPreferenceManager.set("sessions_dir", dir.path)
				}
			}
			
			gPreferenceManager.set("version", newVersion);
			
			// Set flag to display message on update if preference set to true
			if (gPreferenceManager.get("update_message", true)) {
				// If development version, go to development change page
				let dev_version = (/pre\d*/.test(newVersion));
				this._displayUpdateMessage = dev_version ? FIRST_URL_DEV : FIRST_URL;
			}
		}
	},
	
	// This is called from the Session Manager Helper Component.  It would be possible to use the Application event manager to trigger this,
	// but the "ready" event fires after crash processing occurs and the "load" event fires too early.
	initialize: function(extensions)
	{
		log("gSessionManager initialize start", "TRACE");

		// Firefox or SeaMonkey
		let sessionStore = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
		let sessionStart = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		
		if (sessionStore && sessionStart) {
			SessionStore = sessionStore.getService(Ci.nsISessionStore);
			SessionStartup = sessionStart.getService(Ci.nsISessionStartup);
		}
		// Not supported
		else {
			Application.events.addListener("ready", this.onLoad_Uninstall);
			return;
		}
		
		// Determine Mozilla version to see what is supported
		try {
			this.mPlatformVersion = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).platformVersion;
		} catch (ex) { logError(ex); }
		
		// Set flag for Gecko2+
		gecko2plus = (VERSION_COMPARE_SERVICE.compare(this.mPlatformVersion, "2.0") >= 0);
		
		// Convert sessions to Firefox 3.5+ format if never converted them
		convertFF3Sessions = gPreferenceManager.get("lastRanFF3", true);
		gPreferenceManager.set("lastRanFF3", false);
		
		// Everything is good to go so set initialized to true
		this._initialized = true;

		// Get and save the Profile directory
		mProfileDirectory = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);

		this.old_mTitle = this.mTitle = this._string("sessionManager");
		
		// Initialize cache preference values 
		// load "shutdown_on_last_window_close" manually since there's no default for it originally
		this.mPref["shutdown_on_last_window_close"] = gPreferenceManager.get("shutdown_on_last_window_close", false);
		
		let allPrefs = gPreferenceManager.getAllPrefs();
		for (var i in allPrefs) 
			this.mPref[allPrefs[i].name] = allPrefs[i].value;
		
		// split out name and group
		this.getAutoSaveValues(gPreferenceManager.get("_autosave_values", ""));
		gPreferenceManager.observe("", this, false);
		
		// Flag to determine whether or not to use SessionStore Closed Window List
		this.mUseSSClosedWindowList = this.mPref["use_SS_closed_window_list"] && (typeof(SessionStore.getClosedWindowCount) == "function");
		
		// Make sure resume_session is not null.  This could happen in 0.6.2.  It should no longer occur, but 
		// better safe than sorry.
		if (!this.mPref["resume_session"]) {
			gPreferenceManager.set("resume_session", BACKUP_SESSION_FILENAME);
			if (this.mPref["startup"] == 2) gPreferenceManager.set("startup",0);
		}
		
		// Put up saving warning if private browsing mode permanently enabled.
		if (this.isAutoStartPrivateBrowserMode()) {
			if (!gPreferenceManager.get("no_private_browsing_prompt", false)) {
				let dontPrompt = { value: false };
				PROMPT_SERVICE.alertCheck(null, this._string("sessionManager"), this._string("private_browsing_warning"), this._string("prompt_not_again"), dontPrompt);
				if (dontPrompt.value)
				{
					gPreferenceManager.set("no_private_browsing_prompt", true);
				}
			}
		}
		
		// Add observers
		OBSERVING.forEach(function(aTopic) {
			OBSERVER_SERVICE.addObserver(this, aTopic, false);
		}, this);
		
		// Perform any needed update processing here.  For Firefox 4.0 and greater need to use the getExtensions callback
		if (Application.extensions) {
			this.checkForUpdate(Application.extensions);
		} else {
			Application.getExtensions(gSessionManager.getExtensionsCallback);
		}
	
		log("gSessionManager initialize end", "TRACE");
	},
			
/* ........ Listeners / Observers.............. */

	// If SessionStore component does not exist hide Session Manager GUI and uninstall
	onLoad_Uninstall: function()
	{
		log("Uninstalling Because SessionStore does not exist", "INFO");
		Application.events.removeListener("ready", gSessionManager.onLoad_Uninstall);
	
		let title = gSessionManager._string("sessionManager");
		let text = gSessionManager._string("not_supported");
		PROMPT_SERVICE.alert(null, title, text);
		let liExtensionManager = Cc["@mozilla.org/extensions/manager;1"].getService(Ci.nsIExtensionManager);
		liExtensionManager.uninstallItem("{1280606b-2510-4fe0-97ef-9b5a22eafe30}");
		log("Uninstalling Because SessionStore does not exist - done", "INFO");
	},
	
	observe: function(aSubject, aTopic, aData)
	{
		log("gSessionManager.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "browser:purge-session-history":
			this.clearUndoData("all");
			break;
		case "nsPref:changed":
			let old_value = this.mPref[aData];
			this.mPref[aData] = gPreferenceManager.get(aData);
			
			switch (aData)
			{
			case "backup_every":
			case "backup_every_time":
				this.checkBackupTimer(old_value);
				break;
			case "encrypt_sessions":
				if (!this.ignore_encrypt_sessions_preference_change) {
					// if already changing encryption and someone changes preference, revert change
					if (this.mEncryptionChangeInProgress) {
						this.ignore_encrypt_sessions_preference_change = true;
						gPreferenceManager.set("encrypt_sessions", !this.mPref["encrypt_sessions"]);
						delete this.ignore_encrypt_sessions_preference_change;
					}
					else
						this.encryptionChange();
				}
				break;
			case "max_closed_undo":
				if (!this.mUseSSClosedWindowList) {
					if (this.mPref["max_closed_undo"] == 0)
					{
						this.clearUndoData("window", true);
						OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
					}
					else
					{
						let closedWindows = this.getClosedWindows_SM();
						if (closedWindows.length > this.mPref["max_closed_undo"])
						{
							this.storeClosedWindows_SM(closedWindows.slice(0, this.mPref["max_closed_undo"]));
						}
					}
				}
				break;
			case "_autosave_values":
				// split out name and group
				let old_time = this.mPref["_autosave_time"];
				this.getAutoSaveValues(this.mPref["_autosave_values"]);
				this.mPref["_autosave_values"] = null;
				this.checkAutoSaveTimer(old_time);
				OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "use_SS_closed_window_list":
				// Flag to determine whether or not to use SessionStore Closed Window List
				this.mUseSSClosedWindowList = (this.mPref["use_SS_closed_window_list"] && 
				                               typeof(SessionStore.getClosedWindowCount) == "function");
				OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "click_restore_tab":
			case "hide_tools_menu":
			case "show_icon_in_menu":
			case "reload":
			case "session_name_in_titlebar":
			case "do_not_color_toolbar_button":
			case "display_menus_in_submenu":
			case "keys":
				// Use our own preference notification for notifying windows so that the mPref variable will be up to date.
				OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "use_SQLite_cache":
				if (!this.mPref["use_SQLite_cache"])
					gSQLManager.removeSessionFromSQLCache();
				else 
					gSQLManager.updateSQLCache(false, true);
				break;
			case "logging_to_console":
				// Enable the error console and chrome logging when logging to console is enabled so user can
				// see any chrome errors that are generated (which might be caused by Session Manager)
				if (this.mPref["logging_to_console"]) {
					this.gPreferenceManager.set("devtools.errorconsole.enabled", true, true);
					this.gPreferenceManager.set("javascript.options.showInConsole", true, true);
				}
				else {
					this.gPreferenceManager.delete("devtools.errorconsole.enabled", true);
					this.gPreferenceManager.delete("javascript.options.showInConsole", true);
				}
				break;
			}
			break;
		case "quit-application":
			// remove observers
			OBSERVING.forEach(function(aTopic) {
				OBSERVER_SERVICE.removeObserver(this, aTopic);			
			}, this);
			gPreferenceManager.unobserve("", this);
		
			// Don't shutdown, if we've already done so (only occurs if shutdown on last window close is set)
			if (!this.mAlreadyShutdown) {
				// only run shutdown for one window and if not restarting browser (or on restart is user wants)
				if (this.mPref["backup_on_restart"] || (aData != "restart"))
				{
					this.shutDown();
				}
				else
				{
					// Save any active auto-save session, but leave it open.
					this.closeSession(false, false, true);
				}
			}
			break;
		case "quit-application-requested":
			this._restart_requested = (aData == "restart");
			break;
		case "quit-application-granted":
			// quit granted so stop listening for closed windows
			this._stopping = true;
			this._mUserDirectory = this.getUserDir();
			mShutdownState = this.getSessionState(null, null, null, null, null, true);
			break;
		// timer periodic call
		case "timer-callback":
			if (aSubject == this._autosave_timer) {
				// save auto-save session if open, but don't close it
				log("Timer callback for autosave session timer", "EXTRA");
				this.closeSession(false, false, true);
			}
			if (aSubject == this._backup_timer) {
				// save backup session regardless of backup setting
				log("Timer callback for backup session timer", "EXTRA");
				this.backupCurrentSession(false, true);
			}
			break;
		case "private-browsing":
			// When exiting private browsing and not shutting down, restore saved auto session data (saved in Session Manager component)
			if ((aData == "exit") && !this.mShutDownInPrivateBrowsingMode) {
				if (this._pb_saved_autosave_values) {
					gPreferenceManager.set("_autosave_values", this._pb_saved_autosave_values);
					this._pb_saved_autosave_values = null;
				}
			}
			break;
		}
	},

/* ........ Menu Event Handlers .............. */

	init: function(aPopup, aIsToolbar)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }

		// Get window sepecific items
		let window = aPopup.ownerDocument.defaultView;
		let document = window.document;
		let window_session_filename = window.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename;
	
		let separator = get_("separator");
		let backupSep = get_("backup-separator");
		let startSep = get_("start-separator");
		let closer = get_("closer");
		let closerWindow = get_("closer_window");
		let abandon = get_("abandon");
		let abandonWindow = get_("abandon_window");
		let backupMenu = get_("backup-menu");
		let deletedMenu = get_("deleted-menu");
				
		for (let item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		// The first time this function is run after an item is added or removed from the browser toolbar
		// using the customize feature, the backupMenu.menupopup value is not defined.  This happens once for
		// each menu (tools menu and toolbar button).  Using the backupMenu.firstChild will work around this
		// Firefox bug, even though it technically isn't needed.
		let backupPopup = backupMenu.menupopup || backupMenu.firstChild; 
		while (backupPopup.childNodes.length) backupPopup.removeChild(backupPopup.childNodes[0]);
		
		// Delete items from end to start in order to not delete the two fixed menu items.
		let deletedPopup = deletedMenu.menupopup || deletedMenu.firstChild;
		while (deletedPopup.childNodes.length > 2) deletedPopup.removeChild(deletedPopup.childNodes[deletedPopup.childNodes.length - 1]);
		
		closer.hidden = abandon.hidden = (this.mPref["_autosave_filename"]=="");
		closerWindow.hidden = abandonWindow.hidden = !window_session_filename;
		
		get_("autosave-separator").hidden = closer.hidden && closerWindow.hidden && abandon.hidden && abandonWindow.hidden;
		
		// Disable saving in privacy mode or if no windows open
		let inPrivateBrowsing = this.isPrivateBrowserMode() || !this.getBrowserWindows().length;
		this.setDisabled(get_("save"), inPrivateBrowsing);
		this.setDisabled(get_("saveWin"), inPrivateBrowsing);
		
		let sessions = this.getSessions();
		let groupNames = [];
		let groupMenus = {};
		let count = 0;
		let backupCount = 0;
		let deletedCount = 0;
		let user_latest = false;
		let backup_latest = false;
		sessions.forEach(function(aSession, aIx) {
			if (!aSession.backup && !aSession.group && (this.mPref["max_display"] >= 0) && (count >= this.mPref["max_display"])) return;
	
			let key = (aSession.backup || aSession.group)?"":(++count < 10)?count:(count == 10)?"0":"";
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", ((key)?key + ") ":"") + aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("tooltiptext", menuitem.getAttribute("label"));
			menuitem.setAttribute("contextmenu", "sessionmanager-ContextMenu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("backup-item", aSession.backup);
			menuitem.setAttribute("sm_menuitem_type", "session");
			menuitem.setAttribute("accesskey", key);
			menuitem.setAttribute("autosave", /^window|session/.exec(aSession.autosave));
			menuitem.setAttribute("disabled", this.mActiveWindowSessions[aSession.fileName] || false);
			menuitem.setAttribute("crop", "center");
			// only display one latest (even if two have the same timestamp)
			if (!(aSession.backup?backup_latest:user_latest) &&
			    ((aSession.backup?sessions.latestBackUpTime:sessions.latestTime) == aSession.timestamp)) {
				menuitem.setAttribute("latest", true);
				if (aSession.backup) backup_latest = true;
				else user_latest = true;
			}
			if (aSession.fileName == this.mPref["_autosave_filename"]) menuitem.setAttribute("disabled", true);
			if (aSession.backup) {
				backupCount++;
				backupPopup.appendChild(menuitem);
			}
			else {
				if (aSession.group) {
					let groupMenu = groupMenus[aSession.group];
					if (!groupMenu) {
						groupMenu = document.createElement("menu");
						groupMenu.setAttribute("_id", aSession.group);
						groupMenu.setAttribute("label", aSession.group);
						groupMenu.setAttribute("tooltiptext", aSession.group);
						groupMenu.setAttribute("accesskey", aSession.group.charAt(0));
						groupMenu.setAttribute("contextmenu", "sessionmanager-groupContextMenu");
						let groupPopup = document.createElement("menupopup");
						groupPopup.addEventListener("popupshowing", function(event) { event.stopPropagation(); }, false);
						groupMenu.appendChild(groupPopup);
						
						groupNames.push(aSession.group);
						groupMenus[aSession.group] = groupMenu;
					}
					let groupPopup = groupMenu.menupopup || groupMenu.lastChild; 
					groupPopup.appendChild(menuitem);
				}
				else aPopup.insertBefore(menuitem, separator);
			}
		}, this);
		
		// Display groups in alphabetical order at the top of the list
		if (groupNames.length) {
			groupNames.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
			let insertBeforeEntry = startSep.nextSibling;
			
			groupNames.forEach(function(aGroup, aIx) {
				aPopup.insertBefore(groupMenus[aGroup], insertBeforeEntry);
			},this);
		}
		
		// Populate Deleted Sessions
		let deleted_sessions = this.getSessions(null, this._string("deleted_sessions_folder"));
		deleted_sessions.forEach(function(aSession, aIx) {
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("tooltiptext", menuitem.getAttribute("label"));
			menuitem.setAttribute("contextmenu", "sessionmanager-deleted-ContextMenu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("autosave", /^window|session/.exec(aSession.autosave));
			menuitem.setAttribute("sm_menuitem_type", "deleted_session");
			menuitem.setAttribute("crop", "center");
			deletedCount++;
			deletedPopup.appendChild(menuitem);
		});
		
		backupMenu.hidden = (backupCount == 0);
		deletedMenu.hidden = (deletedCount == 0)
		backupSep.hidden = backupMenu.hidden && deletedMenu.hidden;
		
		let undoMenu = get_("undo-menu");
		while (aPopup.lastChild != undoMenu)
		{
			aPopup.removeChild(aPopup.lastChild);
		}
		
		let undoDisabled = ((gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true) == 0) &&
		                    ((!this.mUseSSClosedWindowList && (this.mPref["max_closed_undo"] == 0)) ||
							 (this.mUseSSClosedWindowList && gPreferenceManager.get("browser.sessionstore.max_windows_undo", 10, true) == 0)));
		// In SeaMonkey the undo toolbar exists even when not displayed so check to make sure it's actually in a toolbar.
		let divertedMenu = aIsToolbar && document.getElementById("sessionmanager-undo") && (document.getElementById("sessionmanager-undo").parentNode.localName == "toolbar");
		let canUndo = !undoDisabled && !divertedMenu && this.initUndo(undoMenu.firstChild);
		
		undoMenu.hidden = undoDisabled || divertedMenu || !this.mPref["submenus"];
		startSep.hidden = (this.mPref["max_display"] == 0) || ((sessions.length - backupCount) == 0);
		separator.hidden = (!canUndo && undoMenu.hidden);
		this.setDisabled(undoMenu, !canUndo);
		this.setDisabled(get_("load"), !sessions.length);
		this.setDisabled(get_("rename"), !sessions.length);
		this.setDisabled(get_("remove"), !sessions.length);
		this.setDisabled(get_("group"), !sessions.length);
		
		if (!this.mPref["submenus"] && canUndo)
		{
			for (item = undoMenu.firstChild.firstChild; item; item = item.nextSibling)
			{
				aPopup.appendChild(item.cloneNode(true));
				
				// Event handlers aren't copied so need to set them up again to display status bar text
				if (item.getAttribute("statustext")) {
					aPopup.lastChild.addEventListener("DOMMenuItemActive", gSessionManager.ToggleDisplayOfURL, false);
					aPopup.lastChild.addEventListener("DOMMenuItemInactive",  gSessionManager.ToggleDisplayOfURL, false);
				}
			}
		}
	},

	// Called from Session Prompt window when not in modal mode
	sessionPromptCallBack: function(aCallbackData) {
		let window = aCallbackData.window__SSi ? this.getWindowBySSI(aCallbackData.window__SSi) : null;
		let writing_file = true;
	
		switch(aCallbackData.type) {
			case "save":
				this.save(
					window,
					this.sessionPromptReturnData.sessionName,
					this.sessionPromptReturnData.filename,
					this.sessionPromptReturnData.groupName,
					aCallbackData.oneWindow,
					{ append: this.sessionPromptReturnData.append,
					  autoSave: this.sessionPromptReturnData.autoSave,
					  autoSaveTime: this.sessionPromptReturnData.autoSaveTime,
					  sessionState: this.sessionPromptReturnData.sessionState
					}
				);
				break;
			case "load":
				this.load(
					window,
					this.sessionPromptReturnData.filename, 
					this.sessionPromptReturnData.append ? "newwindow" : (this.sessionPromptReturnData.append_window ? "append" : "overwrite"),
					this.sessionPromptReturnData.sessionState
				);
				writing_file = false;
				break;
			case "group":
				this.group(this.sessionPromptReturnData.filename,this.sessionPromptReturnData.groupName);
				break;
			case "rename":
				this.rename(this.sessionPromptReturnData.filename, this.sessionPromptReturnData.sessionName);
				break;
			case "delete":
				this.remove(this.sessionPromptReturnData.filename, this.sessionPromptReturnData.sessionState);
				break;
		}
		
		return writing_file;
	},

	save: function(aWindow, aName, aFileName, aGroup, aOneWindow, aValues)
	{
		// Need a window if saving a window - duh
		if ((!aWindow && aOneWindow) || this.isPrivateBrowserMode() || !this.getBrowserWindows().length) return;
		
		// Save Window should be modal
		let values = aValues || { text: aWindow ? (this.getFormattedName((aWindow.content.document.title || "about:blank"), new Date()) || (new Date()).toLocaleString()) : "", 
		                          autoSaveable : true, allowNamedReplace : this.mPref["allowNamedReplace"], 
								  callbackData: { type: "save", window__SSi: (aWindow ? aWindow.__SSi : null), oneWindow: aOneWindow }};
								  
		if (!aName)
		{
			if (!this.prompt(this._string("save2_session"), this._string("save_" + ((aOneWindow)?"window":"session") + "_ok"), values, this._string("save_" + ((aOneWindow)?"window":"session")), this._string("save_session_ok2")))
			{
				return;
			}
			aName = values.text;
			aFileName = values.name;
			aGroup = values.group;
		}
		if (aName)
		{
			let file = this.getSessionDir(aFileName || this.makeFileName(aName), !aFileName);
			try
			{
				let oldstate = null, merge = false;
				// If appending, get the old state and pass it to getSessionState to merge with the current state
				if (values.append && aFileName && file.exists()) {
					oldstate = this.readSessionFile(file);
					if (oldstate) {
						let matchArray = SESSION_REGEXP.exec(oldstate);
						if (matchArray) {
							oldstate = oldstate.split("\n")[4];
							oldstate = this.decrypt(oldstate);
							if (oldstate) merge = true;
						}
					}
				}
				this.writeFile(file, this.getSessionState(aName, aOneWindow?aWindow:false, this.getNoUndoData(), values.autoSave, aGroup, null, values.autoSaveTime, values.sessionState, oldstate), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						let refresh = true;
						// Do not make the session active if appending to an auto-save session
						if (!values.append) {
							// Combine auto-save values into string
							let autosaveValues = gSessionManager.mergeAutoSaveValues(file.leafName, aName, aGroup, values.autoSaveTime);
							if (!aOneWindow)
							{
								if (values.autoSave)
								{
									gPreferenceManager.set("_autosave_values", autosaveValues);
								}
								else if (gSessionManager.mPref["_autosave_filename"] == file.leafName)
								{
									// If in auto-save session and user saves on top of it as manual turn off autosave
									gPreferenceManager.set("_autosave_values","");
								}
							}
							else 
							{
								if (values.autoSave)
								{
									// Store autosave values into window value and also into window variables
									gSessionManager.getAutoSaveValues(autosaveValues, aWindow);
									refresh = false;
								}
							}
						}
						
						// Update tab tree if it's open (getAutoSaveValues does this as well so don't do it again if already done)
						if (refresh) OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
						
						// Update SQL cache file
						gSQLManager.addSessionToSQLCache(false, file.leafName);
					}
					else {
						let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioError(exception);
					}
				});
			}
			catch (ex)
			{
				this.ioError(ex, (file ? file.leafName : ""));
			}
		}
	},

	saveWindow: function(aWindow, aName, aFileName, aGroup)
	{
		this.save(aWindow, aName, aFileName, aGroup, true);
	},
	
	// if aOneWindow is true, then close the window session otherwise close the browser session
	closeSession: function(aWindow, aForceSave, aKeepOpen)
	{
		log("closeSession: " + ((aWindow) ? aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename : this.mPref["_autosave_filename"]) + 
		    ", aForceSave = " + (aForceSave || this.mAboutToEnterPrivateBrowsing) + ", aKeepOpen = " + (aKeepOpen || this.mAboutToEnterPrivateBrowsing), "DATA");
		let filename = (aWindow) ? aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename : this.mPref["_autosave_filename"];
		let name = (aWindow) ? aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_name : this.mPref["_autosave_name"];
		let group = (aWindow) ? aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_group : this.mPref["_autosave_group"];
		let time = (aWindow) ? aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_time : this.mPref["_autosave_time"];
		if (filename)
		{
			let file = this.getSessionDir(filename);
			try
			{
				// If forcing a save or not in private browsing save auto or window session.  Use stored closing window state if it exists.
				if (aForceSave || this.mAboutToEnterPrivateBrowsing || !this.isPrivateBrowserMode()) 
					this.writeFile(file, this.getSessionState(name, aWindow, this.getNoUndoData(), true, group, null, time, this.mClosingWindowState || (!aWindow && mShutdownState)), function(aResults) {
						if (Components.isSuccessCode(aResults)) {
							// Update SQL cache file
							gSQLManager.addSessionToSQLCache(false, file.leafName);
						}
						else {
							let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
							this.ioError(exception);
						}
					});
			}
			catch (ex)
			{
				this.ioError(ex, (file ? file.leafName : ""));
			}
		
			// When closing window sessions because entering private browsing, keep session open to allow browser to save window values
			if (!aKeepOpen) {
				if (!aWindow) {
					gPreferenceManager.set("_autosave_values","");
				}
				else if (!this.mAboutToEnterPrivateBrowsing) {
					this.getAutoSaveValues(null, aWindow);
				}
			}
			return true;
		}
		return false;
	},
	
	abandonSession: function(aWindow, aQuiet)
	{
		let dontPrompt = { value: false };
		if (aQuiet || gPreferenceManager.get("no_abandon_prompt") || PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string("abandom_prompt"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			if (aWindow) {
				this.getAutoSaveValues(null, aWindow);
			}
			else {
				gPreferenceManager.set("_autosave_values","");
			}
			if (dontPrompt.value)
			{
				gPreferenceManager.set("no_abandon_prompt", true);
			}
		}
	},
	
	load: function(aWindow, aFileName, aMode, aSessionState)
	{
		log("load: aFileName = " + aFileName + ", aMode = " + aMode + ", aSessionState = " + !!aSessionState, "DATA");
		let state, window_autosave_values, force_new_window = false, overwrite_window = false, use_new_window = false;
		
		// If no window passed, just grab a recent one.  
		aWindow = aWindow || this.getMostRecentWindow("navigator:browser");
		
		// If Mac hidden window, set aWindow to null so we grab a new window
		if (aWindow.location.href == "chrome://browser/content/hiddenWindow.xul")
			aWindow = null;

		if (!aFileName) {
			let values = { append_replace: true, callbackData: { type: "load", window__SSi: (aWindow ? aWindow.__SSi : null) } };
			aFileName = this.selectSession(this._string("load_session"), this._string("load_session_ok"), values);
			let file;
			if (!aFileName || !(file = this.getSessionDir(aFileName)) || !file.exists()) return;
			aSessionState = values.sessionState;
			aMode = values.append ? "newwindow" : (values.append_window ? "append" : "overwrite");
		}
		// If loading passed in state date, get session header data from disk, otherwise get entire session
		state = this.readSessionFile(this.getSessionDir(aFileName), !!aSessionState);
		if (!state)
		{
			this.ioError(new Components.Exception(aFileName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller));
			return;
		}

		let matchArray = SESSION_REGEXP.exec(state);
		if (!matchArray)
		{
			this.sessionError(null, aFileName);
			return;
		}		
		
		// If no passed or recent browser window, open a new one (without prompting for a session)
		if (!aWindow || !aWindow.gBrowser) {
			this._no_prompt_for_session = true;
			aWindow = this.openWindow(gPreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			use_new_window = true;
		}
		
		// If user somehow managed to load an active Window or Auto Session, ignore it
		if ((/^window/.test(matchArray[3]) && this.mActiveWindowSessions[aFileName]) ||
		    (/^session/.test(matchArray[3]) && (this.mPref["_autosave_filename"] == aFileName)))
		{
			log("Opened an already active auto or window session: " + aFileName, "INFO");
			return;
		}

		// handle case when always want a new window (even if current window is blank) and
		// want to overwrite the current window, but not the current session
		switch (aMode) {
			case "newwindow_always":
				force_new_window = true;
				aMode = "newwindow";
				break;
			case "overwrite_window":
				overwrite_window = true;
				aMode = "append";			// Basically an append with overwriting tabs
				break;
		}
		
		let sessionWidth = parseInt(matchArray[9]);
		let sessionHeight = parseInt(matchArray[10]);
		let xDelta = (isNaN(sessionWidth) || (SCREEN_MANAGER.numberOfScreens > 1)) ? 1 : (aWindow.screen.width / sessionWidth);
		let yDelta = (isNaN(sessionHeight) || (SCREEN_MANAGER.numberOfScreens > 1)) ? 1 : (aWindow.screen.height / sessionHeight);
		log("xDelta = " + xDelta + ", yDelta = " + yDelta, "DATA");
			
		state = aSessionState ? aSessionState : state.split("\n")[4];
			
		let startup = (aMode == "startup");
		let newWindow = false;
		let overwriteTabs = true;
		let tabsToMove = null;
		let noUndoData = this.getNoUndoData(true, aMode);

		// Tab Mix Plus's single window mode is enabled
		let TMP_SingleWindowMode = this.tabMixPlusEnabled && gPreferenceManager.get("extensions.tabmix.singleWindow", false, true);
		if (TMP_SingleWindowMode) log("Tab Mix Plus single window mode is enabled", "INFO");

		// Use only existing window if our preference to do so is set or Tab Mix Plus's single window mode is enabled
		let singleWindowMode = (this.mPref["append_by_default"] && (aMode != "newwindow")) || TMP_SingleWindowMode;
	
		if (singleWindowMode && (aMode == "newwindow" || (!startup && (aMode != "overwrite") && !this.mPref["overwrite"])))
			aMode = "append";
		
		// Use specified mode or default.
		aMode = aMode || "default";
		
		if (startup)
		{
			overwriteTabs = this.isCmdLineEmpty(aWindow);
			// Tabs to move to end of tabs
			tabsToMove = (!overwriteTabs)?Array.slice(aWindow.gBrowser.mTabs):null;
			// If user opened multiple windows then don't overwrite the other windows
			if (this.getBrowserWindows().length > 1)
				overwrite_window = true;
		}
		else if (!overwrite_window && (aMode == "append"))
		{
			overwriteTabs = false;
		}
		else if (!use_new_window && !singleWindowMode && !overwrite_window && (aMode == "newwindow" || (aMode != "overwrite" && !this.mPref["overwrite"])))
		{
			// if there is only a blank window with no closed tabs, just use that instead of opening a new window
			let tabs = aWindow.gBrowser;
			if (force_new_window || this.getBrowserWindows().length != 1 || !tabs || tabs.mTabs.length > 1 || 
				tabs.mTabs[0].linkedBrowser.currentURI.spec != "about:blank" || 
				SessionStore.getClosedTabCount(aWindow) > 0) {
				newWindow = true;
			}
		}
		
		// Handle case where trying to restore to a newly opened window and Tab Mix Plus's Single Window Mode is active.
		// TMP is going to close this window after the restore, so restore into existing window
		let altWindow = null;
		if (TMP_SingleWindowMode) {
			let windows = this.getBrowserWindows();
			if (windows.length == 2) {
				log("load: Restoring window into existing window because TMP single window mode active", "INFO");
				if (windows[0] == aWindow) altWindow = windows[1];
				else altWindow = windows[0];
				overwriteTabs = false;
			}
		}

		// Check whether or not to close open auto and window sessions.
		// Don't save current session on startup since there isn't any.  Don't save unless 
		// overwriting existing window(s) since nothing is lost in that case.
		if (!startup && !use_new_window) {
			if ((!newWindow && overwriteTabs) || overwrite_window) {
				// close current window sessions if open
				if (aWindow.com && aWindow.com.morac.SessionManagerAddon && aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject && aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename) 
				{
					this.closeSession(aWindow);
				}
			}
			if (!newWindow && overwriteTabs && !overwrite_window)
			{
				// Closed all open window sessions
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = false;
				OBSERVER_SERVICE.notifyObservers(abandonBool, "sessionmanager:close-windowsession", null);
			
				// close current autosave session if open
				if (this.mPref["_autosave_filename"]) 
				{
					this.closeSession(false);
				}
				else 
				{
					if (this.mPref["autosave_session"]) this.autoSaveCurrentSession();
				}
			}
		}
		
		// If not in private browser mode and did not choose tabs and not appending to current window
		if (!aSessionState && !this.isPrivateBrowserMode() && (overwriteTabs || startup) && !altWindow)
		{
			// if this is a window session, keep track of it
			if (/^window\/?(\d*)$/.test(matchArray[3])) {
				let time = parseInt(RegExp.$1);
				window_autosave_values = this.mergeAutoSaveValues(aFileName, matchArray[1], matchArray[7], time);
				log("load: window session", "INFO");
			}
		
			// If this is an autosave session, keep track of it if not opening it in a new window and if there is not already an active session
			if (!newWindow && !overwrite_window && this.mPref["_autosave_filename"]=="" && /^session\/?(\d*)$/.test(matchArray[3])) 
			{
				let time = parseInt(RegExp.$1);
				gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aFileName, matchArray[1], matchArray[7], time));
			}
		}
		
		// If reload tabs enabled and not offline, set the tabs to allow reloading
		if (this.mPref["reload"] && !IO_SERVICE.offline) {
			try {
				state = this.decrypt(state);
				if (!state) return;
		
				let current_time = new Date();
				current_time = current_time.getTime();
				let tempState = this.JSON_decode(state);
				for (let i in tempState.windows) {
					for (let j in tempState.windows[i].tabs) {
						// Only tag web pages as allowed to reload (this excludes chrome, about, etc)
						if (tempState.windows[i].tabs[j].entries && tempState.windows[i].tabs[j].entries.length != 0 &&
						    /^https?:\/\//.test(tempState.windows[i].tabs[j].entries[tempState.windows[i].tabs[j].index - 1].url)) {
							if (!tempState.windows[i].tabs[j].extData) tempState.windows[i].tabs[j].extData = {};
							tempState.windows[i].tabs[j].extData["session_manager_allow_reload"] = current_time;
						}
					}
				}
				state = this.JSON_encode(tempState);
			}
			catch (ex) { logError(ex); };
		}
		
		// if no browser window open, simply call restoreSession, otherwise do setTimeout.
		if (use_new_window) {
			let okay = gSessionManager.restoreSession(null, state, overwriteTabs, noUndoData, true, (singleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta, aFileName);
			if (!okay) gPreferenceManager.set("_autosave_values", "");
			aWindow.close();
		}
		else {
			aWindow.setTimeout(function() {
				let tabcount = aWindow.gBrowser.mTabs.length;
				let okay = gSessionManager.restoreSession((!newWindow)?(altWindow?altWindow:aWindow):null, state, overwriteTabs, noUndoData, (overwriteTabs && !newWindow && !singleWindowMode && !overwrite_window), 
														  (singleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta, aFileName);
				if (okay) {
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);

					if (tabsToMove)
					{
						let endPos = aWindow.gBrowser.mTabs.length - 1;
						tabsToMove.forEach(function(aTab) { aWindow.gBrowser.moveTabTo(aTab, endPos); });
					}
				}
				// failed to load so clear autosession in case user tried to load one
				else gPreferenceManager.set("_autosave_values", "");
			}, 0);
		}
	},

	rename: function(aSession, aText)
	{
		let values;
		if (aSession && !aText) values = { name: aSession, text: mSessionCache[aSession].name };
		else values = {};
		values.callbackData = { type: "rename" };
		
		// if not callback
		if (!aText) {
			if (!this.prompt(this._string("rename_session"), this._string("rename_session_ok"), values, this._string("rename2_session")))
			{
				return;
			}
		}
		else {
			values.name = aSession;
			values.text = aText;
		}
		let file = this.getSessionDir(values.name);
		let filename = this.makeFileName(values.text);
		let newFile = (filename != file.leafName)?this.getSessionDir(filename, true):null;
		
		try
		{
			if (!file || !file.exists()) throw new Error(this._string("file_not_found"));
		
			this.readSessionFile(file, false, function(state) {
				// remove group name if it was a backup session
				if (mSessionCache[values.name].backup)
					state = state.replace(/\tgroup=[^\t\n\r]+/m, "");
				gSessionManager.writeFile(newFile || file, gSessionManager.nameState(state, values.text), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						if (newFile)
						{
							if (gSessionManager.mPref["resume_session"] == file.leafName && gSessionManager.mPref["resume_session"] != BACKUP_SESSION_FILENAME &&
								!AUTO_SAVE_SESSION_REGEXP.test(gSessionManager.mPref["resume_session"]))
							{
								gPreferenceManager.set("resume_session", newFile.leafName);
							}
							
							gSessionManager.delFile(file, false, true);
						}

						// Update any renamed auto or window session
						gSessionManager.updateAutoSaveSessions(file.leafName, newFile ? newFile.leafName: null, values.text);
						
						// Update tab tree if it's open
						OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
						
						// Update SQL cache file
						gSQLManager.addSessionToSQLCache(false, newFile ? newFile.leafName : filename);
					}
					else {
						let exception = new Components.Exception(newFile ? newFile.leafName : filename, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioerror(exception);
					}
				});
			});
		}
		catch (ex)
		{
			this.ioError(ex, filename);
		}
	},
	
	group: function(aSession, aNewGroup)
	{
		let values = { multiSelect: true, grouping: true, callbackData: { type: "group" } };
		if (typeof(aNewGroup) == "undefined") {
			aSession = this.prompt(this._string("group_session"), this._string("group_session_okay"), values, this._string("group_session_text"));
		}
		else {
			values.name = aSession;
			values.group = aNewGroup;
		}
		
		if (aSession)
		{
			values.name.split("\n").forEach(function(aFileName) {
				try
				{
					let file = this.getSessionDir(aFileName);
					if (!file || !file.exists()) 
						throw new Error(this._string("file_not_found"));
					this.readSessionFile(file, false, function(state) {
						state = state.replace(/(\tcount=\d+\/\d+)(\tgroup=[^\t\n\r]+)?/m, function($0, $1) { return $1 + (values.group ? ("\tgroup=" + values.group.replace(/\t/g, " ")) : ""); });
						gSessionManager.writeFile(file, state, function(aResults) {
							if (Components.isSuccessCode(aResults)) {
								// Update tab tree if it's open
								OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
								
								// Update SQL cache file
								gSQLManager.addSessionToSQLCache(false, file.leafName);
							}
							else {
								let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
								this.ioError(exception);
							}
						});

						// Update cached group name
						mSessionCache[aFileName].group = values.group;
						
						// Update any regrouped auto or window session
						gSessionManager.updateAutoSaveSessions(aFileName, null, null, values.group);
					});
				}
				catch (ex)
				{
					this.ioError(ex, aFileName);
				}
				
			}, this);
		}
	},

	remove: function(aSession, aSessionState)
	{
		if (!aSession || aSessionState)
		{
			let values = { multiSelect: true, remove: true, callbackData: { type: "delete" } };
			aSession = aSession || this.selectSession(this._string("remove_session"), this._string("remove_session_ok"), values);
			aSessionState = aSessionState || values.sessionState;
			
			// If user chose to delete specific windows and tabs in a session
			if (aSessionState) {
				// Get windows and tabs that were not deleted
				try
				{
					let file = this.getSessionDir(aSession);
					if (file.exists()) {
						let sessionStateBackup = aSessionState;
						this.readSessionFile(file, false, function(state) {
							if (state && SESSION_REGEXP.test(state)) {
								state = state.split("\n");
								let count = gSessionManager.getCount(sessionStateBackup);
								state[3] = state[3].replace(/\tcount=[1-9][0-9]*\/[1-9][0-9]*/, "\tcount=" + count.windows + "/" + count.tabs);
								state[4] = gSessionManager.decryptEncryptByPreference(sessionStateBackup);
								state = state.join("\n");
								gSessionManager.writeFile(file, state, function(aResults) {
									if (Components.isSuccessCode(aResults)) {
										// Update tab tree if it's open
										OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
										
										// Update SQL cache file
										gSQLManager.addSessionToSQLCache(false, file.leafName);
									}
									else {
										let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
										this.ioError(exception);
									}
								});
							}
						});
					}
				}
				catch(ex) {
					this.ioError(ex, aSession);
				}
				aSessionState = null;
				aSession = null;
			}
		}
		if (aSession)
		{
			aSession.split("\n").forEach(function(aFileName) {
				// If deleted autoload session, revert to no autoload session
				if ((aFileName == this.mPref["resume_session"]) && (aFileName != BACKUP_SESSION_FILENAME)) {
					gPreferenceManager.set("resume_session", BACKUP_SESSION_FILENAME);
					gPreferenceManager.set("startup", 0);
					// Update Options window if it's open
					let window = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator).getMostRecentWindow("SessionManager:Options");
					if (window) window.updateSpecialPreferences(true);
				}
				// In case deleting an auto-save or window session, update browser data
				this.updateAutoSaveSessions(aFileName);
				this.delFile(this.getSessionDir(aFileName));
			}, this);
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
		}
	},

	openFolder: function()
	{
		let dir = this.getSessionDir();
		if (dir && dir.exists() && dir.isDirectory()) {
			try {
				// "Double click" the session directory to open it
				dir.launch();
			} catch (e) {
				try {
					// If launch also fails (probably because it's not implemented), let the
					// OS handler try to open the session directory
					let uri = Cc["@mozilla.org/network/io-service;1"].
										getService(Ci.nsIIOService).newFileURI(dir);
					let protocolSvc = Cc["@mozilla.org/uriloader/external-protocol-service;1"].
														getService(Ci.nsIExternalProtocolService);
					protocolSvc.loadUrl(uri);
				}
				catch (ex)
				{
					this.ioError(ex, dir.path);
				}
			}
		}
	},

	openOptions: function()
	{
		let dialog = this.getMostRecentWindow("SessionManager:Options");
		if (dialog)
		{
			dialog.focus();
			return;
		}
		
		this.openWindow("chrome://sessionmanager/content/options.xul", "chrome,titlebar,toolbar,centerscreen," + ((gPreferenceManager.get("browser.preferences.instantApply", false, true))?"dialog=no":"modal"), 
		                null, this.getMostRecentWindow());
		
	},

/* ........ Undo Menu Event Handlers .............. */

	// Overlink is used in all versions of Firefox and SeaMonkey to set the link status.  In all
	// except Firefox 4 and up, it sets that status bar text.  In Firefox 4 and up it shows a popup status entry at the bottom of the window
	ToggleDisplayOfURL: function(event) 
	{
		switch(event.type) {
			case "DOMMenuItemActive":
				this.ownerDocument.defaultView.XULBrowserWindow.setOverLink(this.getAttribute("statustext"));
				break;
			case "DOMMenuItemInactive":
				this.ownerDocument.defaultView.XULBrowserWindow.setOverLink('');
				break;
		} 
	},

	initUndo: function(aPopup, aStandAlone)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		// Get window sepecific items
		let window = aPopup.ownerDocument.defaultView;
		let document = window.document;
	
		let separator = get_("closed-separator");
		let label = get_("windows");
		
		for (let item = separator.previousSibling; item != label; item = separator.previousSibling)
		{
			aPopup.removeChild(item);
		}
		
		let defaultIcon = (Application.name.toUpperCase() == "SEAMONKEY") ? "chrome://sessionmanager/skin/bookmark-item.png" :
		                                                            "chrome://sessionmanager/skin/defaultFavicon.png";
		
		let encrypt_okay = true;
		// make sure user enters master password if using sessionmanager.dat
		if (!this.mUseSSClosedWindowList && this.mPref["encrypt_sessions"] && !PasswordManager.enterMasterPassword()) {
			encrypt_okay = false;
			this.cryptError(this._string("decrypt_fail2"));
		}
		
		let number_closed_windows = 0;
		if (encrypt_okay) {
			let badClosedWindowData = false;
			let closedWindows = this.getClosedWindows();
			closedWindows.forEach(function(aWindow, aIx) {
				// Try to decrypt is using sessionmanager.dat, if can't then data is bad since we checked for master password above
				let state = this.mUseSSClosedWindowList ? aWindow.state : this.decrypt(aWindow.state, true);
				if (!state && !this.mUseSSClosedWindowList) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = "crypt_error";
					return;
				}
				state = this.JSON_decode(state, true);
			
				// detect corrupt sessionmanager.dat file
				if (state._JSON_decode_failed && !this.mUseSSClosedWindowList) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = state._JSON_decode_error;
					return;
				}
			
				// Get favicon
				let image = defaultIcon;
				if (state.windows[0].tabs.length > 0) {
					if (state.windows[0].tabs[0].attributes && state.windows[0].tabs[0].attributes.image)
					{
						image = state.windows[0].tabs[0].attributes.image;
					}
				}
				// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
				// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
				// use the work around for https.
				if (/^https:/.test(image)) {
					image = "moz-anno:favicon:" + image;
				}
			
				// Get tab count
				let count = state.windows[0].tabs.length;
		
				let menuitem = document.createElement("menuitem");
				menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
				menuitem.setAttribute("label", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("tooltiptext", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("index", "window" + aIx);
				menuitem.setAttribute("image", image);
				menuitem.setAttribute("sm_menuitem_type", "closed_wintab");
				menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
				menuitem.setAttribute("crop", "center");
				aPopup.insertBefore(menuitem, separator);
			}, this);
		
			// Remove any bad closed windows
			if (badClosedWindowData)
			{
				let error = null;
				for (let i=0; i < closedWindows.length; i++)
				{
					if (closedWindows[i]._decode_error)
					{
						error = closedWindows[i]._decode_error;
						closedWindows.splice(i, 1);
						this.storeClosedWindows_SM(closedWindows);
						// Do this so we don't skip over the next entry because of splice
						i--;
					}
				}
				if (error == "crypt_error") {
					this.cryptError(this._string("decrypt_fail1"));
				}
				else {
					this.sessionError(error, CLOSED_WINDOW_FILE);
				}
			}
			
			number_closed_windows = closedWindows.length;
		}
		
		label.hidden = !encrypt_okay || (number_closed_windows == 0);
		
		let listEnd = get_("end-separator");
		for (let item = separator.nextSibling.nextSibling; item != listEnd; item = separator.nextSibling.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		let closedTabs = SessionStore.getClosedTabData(window);
		let mClosedTabs = [];
		closedTabs = this.JSON_decode(closedTabs);
		closedTabs.forEach(function(aValue, aIndex) {
			mClosedTabs[aIndex] = { title:aValue.title, image:null, 
								url:aValue.state.entries[aValue.state.entries.length - 1].url }
			// Get favicon
			mClosedTabs[aIndex].image = defaultIcon;
			if (aValue.state.attributes && aValue.state.attributes.image)
			{
				mClosedTabs[aIndex].image = aValue.state.attributes.image;
			}
			// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
			// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
			// use the work around for https.
			if (/^https:/.test(mClosedTabs[aIndex].image)) {
				mClosedTabs[aIndex].image = "moz-anno:favicon:" + mClosedTabs[aIndex].image;
			}
		}, this);

		mClosedTabs.forEach(function(aTab, aIx) {
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
			menuitem.setAttribute("image", aTab.image);
			menuitem.setAttribute("label", aTab.title);
			menuitem.setAttribute("tooltiptext", aTab.title + "\n" + aTab.url);
			menuitem.setAttribute("index", "tab" + aIx);
			menuitem.setAttribute("statustext", aTab.url);
			menuitem.setAttribute("sm_menuitem_type", "closed_wintab");
			menuitem.setAttribute("crop", "center");
			menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
			menuitem.addEventListener("DOMMenuItemActive", gSessionManager.ToggleDisplayOfURL, false);
			menuitem.addEventListener("DOMMenuItemInactive",  gSessionManager.ToggleDisplayOfURL, false);
			aPopup.insertBefore(menuitem, listEnd);
		}, this);
		
		separator.nextSibling.hidden = get_("clear_tabs").hidden = (mClosedTabs.length == 0);
		separator.hidden = get_("clear_windows").hidden = get_("clear_tabs").hidden = separator.nextSibling.hidden || label.hidden;

		let showPopup = number_closed_windows + mClosedTabs.length > 0;
		
		if (aStandAlone && !showPopup) {
			window.com.morac.SessionManagerAddon.gSessionManagerWindowObject.updateUndoButton(false);
			window.setTimeout(function(aPopup) { aPopup.parentNode.open = false; }, 0, aPopup);
		}

		return showPopup;
	},

	undoCloseWindow: function(aWindow, aIx, aMode)
	{
		let closedWindows = this.getClosedWindows();
		if (closedWindows[aIx || 0])
		{
			let state = closedWindows.splice(aIx || 0, 1)[0].state;
			
			// If no window passed in or not a real window (no windows open), make sure aMode is not overwrite or append and don't show session prompt
			if (!aWindow || (aWindow.location.href == "chrome://browser/content/hiddenWindow.xul")) {
				aMode = null;
				aWindow = null;
				this._no_prompt_for_session = true;
			}
			// Tab Mix Plus's single window mode is active
			else if (this.tabMixPlusEnabled && gPreferenceManager.get("extensions.tabmix.singleWindow", false, true)) 
				aMode = "append";

			if (aMode == "overwrite")
			{
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
			
			// If using SessionStore closed windows list and doing a normal restore, just use SessionStore API
			if (this.mUseSSClosedWindowList && (aMode != "append") && (aMode != "overwrite")) {
				SessionStore.undoCloseWindow(aIx);
			}
			else {
				let okay = this.restoreSession((aMode == "overwrite" || aMode == "append")?aWindow:null, state, aMode != "append");
				if (okay) {
					this.storeClosedWindows(aWindow, closedWindows, aIx);
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
				}
			}
		}
	},
	
	commandSessionManagerMenu: function(event)
	{
		// Prevent toolbar button handling this event
		event.stopPropagation();
		
		// If a dynamic menu item process it
		let type = event.originalTarget.getAttribute("sm_menuitem_type");
		if (type)
			this.processSessionManagerMenuItem(type, 0, event);
	},
	
	clickSessionManagerMenu: function(event)
	{
		// Prevent toolbar button handling this event
		event.stopPropagation();
		
		// If middle clicking on any dynamic menu item or right clicking on a closed window or tab item or deleted session, process it
		let type = event.originalTarget.getAttribute("sm_menuitem_type");
		if ((type && (event.button == 1)) || ((event.button == 2) && ((type == "closed_wintab") || (type == "deleted_session")))) 
			this.processSessionManagerMenuItem(type, event.button, event);
	},
	
	processSessionManagerMenuItem: function(type, button, event) {
		let ctrl_keys = (event.ctrlKey || event.metaKey);
		let filename = event.originalTarget.getAttribute("filename");
		let middle_click =(button == 1);
		// Take action depending on the menu item type
		switch(type) {
			case "deleted_session":
				// Restore clicked menu item if it is a deleted session, or delete if ctrl right click it
				if (filename) {
					if (button != 2) {
						let file = this.getSessionDir(this._string("deleted_sessions_folder"));
						file.append(filename);
						this.restoreDeletedSessionFile(file);
						// If middle click, menu doesn't close so update the menu
						if (middle_click) {
							let popup = event.originalTarget.parentNode.parentNode.parentNode;
							this.init(popup, popup.id == "sessionmanager-toolbar-popup");
						}
					}
					else if (ctrl_keys) {
						this.deleted_session_delete(null, filename);
						// remove from menu
						event.originalTarget.parentNode.removeChild(event.originalTarget);
						event.preventDefault();
					}
				}
				break;
			case "session":
				if (filename) 
					this.load(event.view, filename, (!middle_click && event.shiftKey && ctrl_keys)?"overwrite":(middle_click || event.shiftKey)?"newwindow":(ctrl_keys)?"append":"");
				// Middle click doesn't hide the popup, so hide it manually
				if (middle_click) 
					event.originalTarget.parentNode.hidePopup(); 
				break;
			case "closed_wintab":
				this.processClosedUndoMenuItem(event, button);
			default:
				break;
		}
	},

	processClosedUndoMenuItem: function(event, button) 
	{
		// if ctrl/command right click, ignore so context-menu opens.
		if (button == 2)
		{
			// If also press ctrl or meta key, remove the item and prevent context-menu from opening
			if (event.ctrlKey || event.metaKey) {
				this.removeUndoMenuItem(event.originalTarget);
				// Don't show context menu
				event.preventDefault();
			}
			return;
		}

		// Find index of item clicked
		let match_array = event.originalTarget.getAttribute("index").match(/^(window|tab)(\d+)$/);
		if (match_array) {
			let tabWindow = match_array[1];
			let aIx = match_array[2];
			
			// If middle click and closed tab, restore it without closing menu
			let window = event.view;
			if (tabWindow == "tab") {
				window.undoCloseTab(aIx)
			}	
			else {
				this.undoCloseWindow(window, aIx, (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.ctrlKey || event.metaKey)?"append":"");
			}
			
			// If middle click, update list
			if (button == 1)
				this.updateClosedList(event.originalTarget, aIx, tabWindow);
		}
	},
	
	removeUndoMenuItem: function(aTarget)
	{	
		let window = aTarget.ownerDocument.defaultView;
			
		let aIx = null;
		let indexAttribute = aTarget.getAttribute("index");
		// removing window item
		if (indexAttribute.indexOf("window") != -1) {
			// get index
			aIx = indexAttribute.substring(6);
			
			// If using built in closed window list, use SessionStore method.
			if (this.mUseSSClosedWindowList) {
				SessionStore.forgetClosedWindow(aIx);
				
				// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
				SessionStore.setWindowValue(window, "SM_dummy_value","1");
				SessionStore.deleteWindowValue(window, "SM_dummy_value");
			}
			else {
				// remove window from closed window list and tell other open windows
				let closedWindows = this.getClosedWindows();
				closedWindows.splice(aIx, 1);
				this.storeClosedWindows(window, closedWindows, aIx);
			}
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", "window");

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, "window");
		}
		// removing tab item
		else if (indexAttribute.indexOf("tab") != -1) {
			// get index
			aIx = indexAttribute.substring(3);

			// If Firefox bug 461634 is fixed use SessionStore method.
			if (typeof(SessionStore.forgetClosedTab) != "undefined") {
				SessionStore.forgetClosedTab(window, aIx);
			}
			else {
				// This code is based off of code in Tab Mix Plus
				let state = { windows: [], _firstTabs: true };

				// get closed-tabs from nsSessionStore
				let closedTabs = this.JSON_decode(SessionStore.getClosedTabData(window));
				// purge closed tab at aIndex
				closedTabs.splice(aIx, 1);
				state.windows[0] = { _closedTabs : closedTabs };

				// replace existing _closedTabs
				SessionStore.setWindowState(window, this.JSON_encode(state), false);
			}

			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			SessionStore.setWindowValue(window, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(window, "SM_dummy_value");
			
			// Update toolbar button if no more tabs
			if (SessionStore.getClosedTabCount(window) == 0) 
			{
				OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-undo-button", "tab");
			}

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, "tab");
		}
	},
	
	updateClosedList: function(aMenuItem, aIx, aType) 
	{
		// Get menu popup
		let popup = aMenuItem.parentNode;

		// remove item from list
		popup.removeChild(aMenuItem);
					
		// Hide popup if no more tabs, an empty undo popup contains 7 items (submenu and undo close toolbar only - see sessionmanager.xul file)
		if (popup.childNodes.length == 7) 
		{
			popup.hidePopup();
		}
		// otherwise adjust indexes
		else 
		{
			for (let i=0; i<popup.childNodes.length; i++)
			{ 
				let index = popup.childNodes[i].getAttribute("index");
				if (index && index.substring(0,aType.length) == aType)
				{
					let indexNo = index.substring(aType.length);
					if (parseInt(indexNo) > parseInt(aIx))
					{
						popup.childNodes[i].setAttribute("index",aType + (parseInt(indexNo) - 1).toString());
					}
				}
			}
			
			// Since main menu items are clones of submenu and below them try and return array entry 1 if it exists
			function get_(a_id) { 
				let elems = popup.getElementsByAttribute("_id", a_id);
				return elems[1] || elems[0] || null; 
			}

			let no_windows = get_("windows").nextSibling == get_("closed-separator");
			let no_tabs = get_("tabs").nextSibling == get_("end-separator");
			let main_separator = get_("separator");
			
			// If removed all of a specific type, hide that type header and footer menu items.
			// If removed everything (none sub-menu), hide all undo close related stuff
			get_("clear_windows").hidden = get_("clear_tabs").hidden = no_windows || no_tabs;
			get_("windows").hidden = get_("closed-separator").hidden = no_windows;
			get_("tabs").hidden = get_("end-separator").hidden = no_tabs;
			get_("clear_all").hidden = no_windows && no_tabs;
			if (main_separator)
				main_separator.hidden = no_windows && no_tabs;
		}
	},

	clearUndoList: function(aType)
	{
		let window = this.getMostRecentWindow("navigator:browser");
	
		if (aType != "window") {
			if (window && typeof(SessionStore.forgetClosedTab) == "function") {
				while (SessionStore.getClosedTabCount(window)) SessionStore.forgetClosedTab(window, 0);
			}
			else {
				let max_tabs_undo = gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true);
				
				gPreferenceManager.set("browser.sessionstore.max_tabs_undo", 0, true);
				gPreferenceManager.set("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);
				// Check to see if the value was set correctly.  Tab Mix Plus will reset the max_tabs_undo preference 
				// to 10 when changing from 0 to any number.  See http://tmp.garyr.net/forum/viewtopic.php?t=10158
				if (gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true) != max_tabs_undo) {
					gPreferenceManager.set("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);
				}
			}
		}

		if (aType != "tab") {
			if (this.mUseSSClosedWindowList) {
				while (SessionStore.getClosedWindowCount()) SessionStore.forgetClosedWindow(0);
			}
			else {
				this.clearUndoData("window");
			}
		}
		
		if (window) {
			// the following forces SessionStore to save the state to disk which isn't done for some reason.
			SessionStore.setWindowValue(window, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(window, "SM_dummy_value");
		}
		
		OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
	},
	
/* ........ Right click menu handlers .............. */
	group_popupInit: function(aPopup) {
		let document = aPopup.ownerDocument.defaultView.document;
		let childMenu = document.popupNode.menupopup || document.popupNode.lastChild;
		childMenu.hidePopup();
	},
	
	group_rename: function(aWindow) {
		let filename = aWindow.document.popupNode.getAttribute("filename");
		let parentMenu = aWindow.document.popupNode.parentNode.parentNode;
		let group = filename ? ((parentMenu.id != "sessionmanager-toolbar" && parentMenu.id != "sessionmanager-menu" && parentMenu.id != "sessionmanager-appmenu") ? parentMenu.label : "")
		                     : aWindow.document.popupNode.getAttribute("label");
		let newgroup = { value: group };
		let dummy = {};
		PROMPT_SERVICE.prompt(aWindow, this._string("rename_group"), null, newgroup, null, dummy);
		if (newgroup.value == this._string("backup_sessions")) {
			PROMPT_SERVICE.alert(aWindow, this.mTitle, this._string("rename_fail"));
			return;
		}
		else if (newgroup.value != group) {
			// changing group for one session or multiple sessions?
			if (filename) this.group(filename, newgroup.value);
			else {
				let sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (!aSession.backup && (aSession.group == group)) {
						this.group(aSession.fileName, newgroup.value);
					}
				}, this);
			}
		}
	},
	
	group_remove: function(aWindow) {
		let group = aWindow.document.popupNode.getAttribute("label");
		if (PROMPT_SERVICE.confirm(aWindow, this.mTitle, this._string("delete_confirm_group"))) {
			
			let sessions = this.getSessions();
			let sessionsToDelete = [];
			sessions.forEach(function(aSession) {
				if (!aSession.backup && (aSession.group == group)) {
					sessionsToDelete.push(aSession.fileName);
				}
			}, this);
			if (sessionsToDelete.length) {
				sessionsToDelete = sessionsToDelete.join("\n");
				this.remove(sessionsToDelete);
			}
		}
	},

	session_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		let document = aPopup.ownerDocument.defaultView.document;
		
		let current = (document.popupNode.getAttribute("disabled") == "true");
		let autosave = document.popupNode.getAttribute("autosave");
		let replace = get_("replace");
		
		replace.hidden = (this.getBrowserWindows().length == 1);
		
		// Disable saving in privacy mode or loaded auto-save session
		let inPrivateBrowsing = this.isPrivateBrowserMode() || !this.getBrowserWindows().length;
		this.setDisabled(replace, (inPrivateBrowsing | current));
		this.setDisabled(get_("replacew"), (inPrivateBrowsing | current));
		
		// Disable almost everything for currently loaded auto-save session
		this.setDisabled(get_("loadaw"), current);
		this.setDisabled(get_("loada"), current);
		this.setDisabled(get_("loadr"), current);

		// Hide change group choice for backup items		
		get_("changegroup").hidden = (document.popupNode.getAttribute("backup-item") == "true")
		
		// Hide option to close or abandon sessions if they aren't loaded
		get_("closer").hidden = get_("abandon").hidden = !current || (autosave != "session");
		get_("closer_window").hidden = get_("abandon_window").hidden = !current || (autosave != "window");
		get_("close_separator").hidden = get_("closer").hidden && get_("closer_window").hidden;
		
		// Disable setting startup if already startup
		this.setDisabled(get_("startup"), ((this.mPref["startup"] == 2) && (document.popupNode.getAttribute("filename") == this.mPref["resume_session"])));
		
		// If Tab Mix Plus's single window mode is enabled, hide options to load into new windows
		get_("loada").hidden = (this.tabMixPlusEnabled && gPreferenceManager.get("extensions.tabmix.singleWindow", false, true));
	},

	session_close: function(aWindow, aOneWindow, aAbandon) {
		if (aOneWindow) {
			let document = aWindow.document;
			let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
			abandonBool.data = (aAbandon == true);
			OBSERVER_SERVICE.notifyObservers(abandonBool, "sessionmanager:close-windowsession", document.popupNode.getAttribute("filename"));
		}
		else {
			if (aAbandon) this.abandonSession();
			else this.closeSession();
		}
	},
	
	session_load: function(aWindow, aReplace, aOneWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		let oldOverwrite = this.mPref["overwrite"];
		this.mPref["overwrite"] = !!aReplace;
		this.load(aWindow, session, (aReplace?"overwrite":(aOneWindow?"append":"newwindow")));
		this.mPref["overwrite"] = oldOverwrite;
	},
	
	session_replace: function(aWindow, aOneWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		let parent = document.popupNode.parentNode.parentNode;
		let group = null;
		if (parent.id.indexOf("sessionmanager-") == -1) {
			group = parent.label;
		}
		if (aOneWindow) {
			this.saveWindow(aWindow, mSessionCache[session].name, session, group);
		}
		else {
			this.save(aWindow, mSessionCache[session].name, session, group);
		}
	},
	
	session_rename: function(aWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		this.rename(session);
	},

	session_remove: function(aWindow) {
		let dontPrompt = { value: false };
		let session = aWindow.document.popupNode.getAttribute("filename");
		if (gPreferenceManager.get("no_delete_prompt") || PROMPT_SERVICE.confirmEx(aWindow, this.mTitle, this._string("delete_confirm"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0) {
			this.remove(session);
			if (dontPrompt.value) {
				gPreferenceManager.set("no_delete_prompt", true);
			}
		}
	},
	
	session_setStartup: function(aWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		gPreferenceManager.set("resume_session", session);
		gPreferenceManager.set("startup", 2);
	},
	
	deleted_session_delete: function(aWindow, aFileName) {
		let file = this.getSessionDir(this._string("deleted_sessions_folder"));
		file.append(aFileName || aWindow.document.popupNode.getAttribute("filename"));
		this.delFile(file, false, true);
	},
	
/* ........ User Prompts .............. */

	openSessionExplorer: function() {
		this.openWindow(
			"chrome://sessionmanager/content/sessionexplorer.xul",
//			"chrome://sessionmanager/content/places/places.xul",
			"chrome,titlebar,resizable,dialog=yes",
			{},
			this.getMostRecentWindow()
		);
	},
	
	// This will always put up an alert prompt in the main thread
	threadSafeAlert: function(aText) {
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			PROMPT_SERVICE.alert(this.getMostRecentWindow(), this.mTitle, aText);
		}
		else {
			let mainThread = Cc["@mozilla.org/thread-manager;1"].getService(Ci.nsIThreadManager).mainThread;
			mainThread.dispatch(new mainAlertThread(aText), mainThread.DISPATCH_NORMAL);
		}
	},

	prompt: function(aSessionLabel, aAcceptLabel, aValues, aTextLabel, aAcceptExistingLabel)
	{
		// Use existing dialog window if not modal
		let dialog = WINDOW_MEDIATOR_SERVICE.getMostRecentWindow("SessionManager:SessionPrompt");
    
		// For some reason someone got two startup prompts, this will prevent that
		if (dialog && !this.isRunning()) {
			if (!dialog.com.morac.SessionManagerAddon.gSessionManagerSessionPrompt.modal)
				dialog.close();
			else
				dialog.setTimeout(function() { dialog.focus(); }, 1000);
				return;
		}
  
		let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
		aValues = aValues || {};

		// Modal if startup or crash prompt or if there's a not a callback function or saving one window
		let window = this.isRunning() ? this.getMostRecentWindow("navigator:browser") : null;
		let modal = !this.isRunning() || !aValues.callbackData;
		//let modal = !this.isRunning() || !aValues.callbackData || aValues.callbackData.oneWindow;
		
		// Clear out return data and initialize it
		this.sessionPromptReturnData = null;
		
		this.sessionPromptData = {
			// strings
			acceptExistingLabel: aAcceptExistingLabel || "",
			acceptLabel: aAcceptLabel,
			callbackData: aValues.callbackData || null,
			crashCount: aValues.count || "",
			defaultSessionName: aValues.text || "",
			filename: aValues.name || "",
			sessionLabel: aSessionLabel,
			textLabel: aTextLabel || "",
			// booleans
			addCurrentSession: aValues.addCurrentSession,
			allowNamedReplace: aValues.allowNamedReplace,
			append_replace: aValues.append_replace,
			autoSaveable: aValues.autoSaveable,
			grouping: aValues.grouping,
			ignorable: aValues.ignorable,
			multiSelect: aValues.multiSelect,
			preselect: aValues.preselect,
			remove: aValues.remove,
			selectAll: aValues.selectAll,
			startupPrompt: aValues.startupPrompt,
			modal: modal,
			startup: !this.isRunning(),
			// override function
			getSessionsOverride: aValues.getSessionsOverride,
		};

		// Initialize return data if modal.  Don't initialize if not modal because that can result in a memory leak since it might
		// not be cleared
		if (modal) this.sessionPromptReturnData = {};
		
		if (dialog && !modal)
		{
			dialog.focus();
			dialog.com.morac.SessionManagerAddon.gSessionManagerSessionPrompt.drawWindow();
			return;
		}
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,resizable,dialog=yes" + (modal?",modal":""), 
		                params, window);
						
		if (params.GetInt(0)) {
			aValues.append = this.sessionPromptReturnData.append;
			aValues.append_window = this.sessionPromptReturnData.append_window;
			aValues.autoSave = this.sessionPromptReturnData.autoSave;
			aValues.autoSaveTime = this.sessionPromptReturnData.autoSaveTime;
			aValues.group = this.sessionPromptReturnData.groupName;
			aValues.name = this.sessionPromptReturnData.filename;
			aValues.text = this.sessionPromptReturnData.sessionName;
			aValues.sessionState = this.sessionPromptReturnData.sessionState;
			this.sessionPromptReturnData.sessionState = null;
		}
		aValues.ignore = this.sessionPromptReturnData ? this.sessionPromptReturnData.ignore : null;

		// Clear out return data
		this.sessionPromptReturnData = null;
		
		return params.GetInt(0);
	},
	
	// the aOverride variable in an optional callback procedure that will be used to get the session list instead
	// of the default getSessions() function.  The function must return an array of sessions where a session is an
	// object containing:
	//		name 		- This is what is displayed in the session select window
	//		fileName	- This is what is returned when the object is selected
	//		windows		- Window count (optional - if omited won't display either window or tab count)
	//		tabs		- Tab count	(optional - if omited won't display either window or tab count)
	//		autosave	- Will cause item to be bold (optional)
	//      group       - Group that session is associated with (optional)
	//
	// If the session list is not formatted correctly a message will be displayed in the Error console
	// and the session select window will not be displayed.
	//
	selectSession: function(aSessionLabel, aAcceptLabel, aValues, aOverride)
	{
		let values = aValues || {};
		
		if (aOverride) values.getSessionsOverride = aOverride;
		
		if (this.prompt(aSessionLabel, aAcceptLabel, values))
		{
			return values.name;
		}
		
		return null;
	},
	
	// Put up error prompt
	error: function(aException, aString, aExtraText) {
		if (aException) logError(aException);
	
		this.threadSafeAlert(SM_BUNDLE.formatStringFromName(aString, [(aException)?(aException.message + (aExtraText ? ("\n\n" + aExtraText) : "") + "\n\n" + aException.location):SM_BUNDLE.GetStringFromName("unknown_error")], 1));
	},

	ioError: function(aException, aText)
	{
		this.error(aException, "io_error", aText);
	},

	sessionError: function(aException, aText)
	{
		this.error(aException, "session_error", aText);
	},

	openWindow: function(aChromeURL, aFeatures, aArgument, aParent)
	{
		if (!aArgument || typeof aArgument == "string")
		{
			let argString = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
			argString.data = aArgument || "";
			aArgument = argString;
		}
		
		return Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher).openWindow(aParent || null, aChromeURL, "_blank", aFeatures, aArgument);
	},

	clearUndoListPrompt: function(aType)
	{
		let dontPrompt = { value: false };
		let prompttext = (aType == "tab") ? "clear_tab_list_prompt" : ((aType == "window") ? "clear_window_list_prompt" : "clear_list_prompt");
		if (gPreferenceManager.get("no_" + prompttext) || PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string(prompttext), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			this.clearUndoList(aType);
			if (dontPrompt.value)
			{
				gPreferenceManager.set("no_" + prompttext, true);
			}
		}
	},
	
/* ........ File Handling .............. */
	// Used to save window sessions that were open when browser crashed
	saveCrashedWindowSessions: function()
	{
		// Don't save if in private browsing mode
		let file = this.getSessionDir(this._crash_backup_session_file);
		if (file) {
			this.readSessionFile(file, false, function(crashed_session) {
				if (crashed_session) {
					crashed_session = gSessionManager.decrypt(crashed_session.split("\n")[4], true);
					if (crashed_session) {
						crashed_session = gSessionManager.JSON_decode(crashed_session, true);
						if (!crashed_session._JSON_decode_failed) {
							// Save each window session found in crashed file
							crashed_session.windows.forEach(function(aWindow) {
								if (aWindow.extData && aWindow.extData._sm_window_session_values) {
									// read window session data and save it and the window into the window session file		
									let window_session_data = aWindow.extData._sm_window_session_values.split("\n");
									gSessionManager.saveWindowSession(window_session_data, aWindow);
								}
							});
						}
					}
				}
			});
		}
	},
	
	saveWindowSession: function(aWindowSessionData, aWindowState)
	{
		log("saveWindowSession: Saving Window Session: " + aWindowSessionData[0] + ", " + aWindowSessionData[1] + ", " + aWindowSessionData[2] + ", " + aWindowSessionData[3], "DATA");
		if (aWindowSessionData[0]) {
			let file = this.getSessionDir(aWindowSessionData[0]);
			
			try
			{
				let window_session = this.JSON_encode({ windows:[ aWindowState ] });
				this.writeFile(file, this.getSessionState(aWindowSessionData[1], true, this.getNoUndoData(), true, aWindowSessionData[2], null, aWindowSessionData[3], window_session), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						gSQLManager.addSessionToSQLCache(false, file.leafName);
					}
					else {
						let exception = new Components.Exception(file.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioError(exception);
					}
				});
			}
			catch (ex)
			{
				this.ioError(ex, (file ? file.leafName : ""));
			}
		}
	},
	
	sanitize: function(aRange)
	{
		log("sanitize - aRange = " + aRange, "DATA");
		// If "Clear Recent History" prompt then use range, otherwise remove all sessions
		if (aRange && (typeof aRange[0] == "number")) {
			let error = null;
			let errorFileName = null;
			// Delete sessions folder first, then deleted folder.  Only delete sessions after startDate.
			for (var i=0; i<2; i++) {
				let sessions = (i==0) ? this.getSessions() : this.getSessions(null, this._string("deleted_sessions_folder"));
				let folder = (i==0) ? "" : this._string("deleted_sessions_folder");
				sessions.forEach(function(aSession, aIx) { 
					if (aRange[0] <= aSession.timestamp*1000) {
						try {
							log("Deleting " + aSession.fileName, "EXTRA");
							let file = this.getSessionDir(folder);
							file.append(aSession.fileName);
							this.delFile(file, false, true);
						}
						catch(ex) {
							error = ex;
							errorFileName = (folder ? (folder + "/") : "") + aSession.fileName;
							logError(ex);
						}
					}
				}, this);
			}
			if (error) this.ioError(ex, errorFileName);
		}
		else {
			try {
				this.getSessionDir().remove(true);
				// clear out cache;
				mSessionCache = [];
				gSQLManager.removeSessionFromSQLCache();
			}
			catch(ex) {
				logError(ex);
			}
		}
	},

	getProfileFile: function(aFileName)
	{
		let file = mProfileDirectory.clone();
		file.append(aFileName);
		return file;
	},
	
	getUserDir: function(aFileName)
	{
		let dir = null;
		let dirname = gPreferenceManager.get("sessions_dir", "");
		try {
			if (dirname) {
				dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
				dir.initWithPath(dirname);
				if (!dir.exists())
				{
					try {
						dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
					}
					catch (ex) {
						if (!reportedUserSessionFolderIOError) {
							reportedUserSessionFolderIOError = true;
							this.ioError(ex, dir.path);
							log("User folder '" + dir.path + "' cannot be read or created.  Using default session dir.", "ERROR", true);
						}
						dir = null;
						// execute jumps to finally clause below which returns dir (null) 
						return null;
					}
				}
				reportedUserSessionFolderIOError = false;
				if (aFileName) {
					if (dir.isDirectory() && dir.isWritable()) {
						dir.append(aFileName);
					}
					else {
						dir = null;
					}
				}
			}
		} catch (ex) {
			// handle the case on shutdown since the above will always throw an exception on shutdown
			if (this._mUserDirectory) dir = this._mUserDirectory.clone();
			else dir = null;
		} finally {
			return dir;
		}
	},

	getSessionDir: function(aFileName, aUnique)
	{
		// Check for absolute path first, session names can't have \ or / in them so this will work.  Relative paths will throw though.
		if (/[\\\/]/.test(aFileName)) {
			let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
			try {
				file.initWithPath(aFileName);
			}
			catch(ex) {
				this.ioError(ex, aFileName);
				file = null;
			}
			return file;
		}
		else {
			// allow overriding of location of sessions directory
			let dir = this.getUserDir();
			
			// use default is not specified or not a writable directory
			if (dir == null) {
				dir = this.getProfileFile("sessions");
			}
			if (!dir.exists())
			{
				try {
					dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
				}
				catch (ex) {
					this.ioError(ex, dir.path);
					return null;
				}
			}
			if (!dir.isDirectory()) {
				this.ioError(new Components.Exception(dir.path, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller));
				return null;
			}
			if (aFileName)
			{
				dir.append(aFileName);
				if (aUnique)
					dir = this.makeUniqueSessionFileName(dir, aFileName);
			}
			return dir.QueryInterface(Ci.nsILocalFile);
		}
	},
	
	makeUniqueSessionFileName: function(dir, aFileName)
	{
		let postfix = 1, ext = "";
		if (aFileName.slice(-SESSION_EXT.length) == SESSION_EXT)
		{
			aFileName = aFileName.slice(0, -SESSION_EXT.length);
			ext = SESSION_EXT;
		}
		while (dir.exists())
		{
			dir = dir.parent;
			dir.append(aFileName + "-" + (++postfix) + ext);
		}
		return dir;
	},

	// Cache the session data so menu opens faster, don't want to use async since that reads the entire
	// file in and we don't need to do that.  So simulate it by doing a bunch of short synchronous reads.
	// This reads in one file every 50 ms.  Since it's possible for getSessions() to be called during that
	// time frame, simply stop caching if a session is already cached as that means getSessions() was called.
	cacheSessions: function(aSubFolder) {
		let encryption_mismatch = false;
		let sessionFiles = [];
		let folder = this.getSessionDir(aSubFolder);
		if (!folder.exists()) {
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:startup-process-finished", null);
			return;
		}
		let filesEnum = folder.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
		let folderName = aSubFolder ? (aSubFolder + "/") : "";
		while (filesEnum.hasMoreElements())
		{
			let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
			// don't try to read a directory
			if (file.isDirectory()) continue;
			sessionFiles.push({filename: file.leafName, lastModifiedTime: file.lastModifiedTime});
		}
		let cache_count = sessionFiles.length;
		if (!cache_count) {
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:startup-process-finished", null)
			return;
		}
		
		log("gSessionManager:cacheSessions: Caching " + cache_count + " session files" + (aSubFolder ? (" in " + aSubFolder) : "") + ".", "INFO");	
		// timer call back function to cache session data
		var callback = {
			timer: null, // needed to prevent timer from being garbage collected which will stop timer (see Firefox bug 640629)
			notify: function(timer) {
				//let a = Date.now();
				let session;
				try {
					session = sessionFiles.pop();
				}
				catch(ex) { 
					logError(ex);
					session = null;
				};
				// if the session is already cached, that means getSession() was called so stop caching sessions, also stop on an encryption mismatch since
				// the encryption change processing will kick off and that reads files as well.
				if (!encryption_mismatch && session && !mSessionCache[folderName + session.filename]) {
					let file = folder.clone();
					file.append(session.filename);
					let session_data = gSessionManager.readSessionFile(file, true);
					let matchArray;
					if (matchArray = SESSION_REGEXP.exec(session_data))
					{
						let timestamp = parseInt(matchArray[2]) || session.lastModifiedTime;
						let backupItem = BACKUP_SESSION_REGEXP.test(session.filename);
						let group = matchArray[7] ? matchArray[7] : "";
						let encrypted = (session_data.split("\n")[4].indexOf(":") == -1);
						encryption_mismatch = encryption_mismatch || (encrypted != gSessionManager.mPref["encrypt_sessions"]);
						// save mSessionCache data
						mSessionCache[folderName + session.filename] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: session.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group, encrypted: encrypted };
					}
					else
						gSessionManager.moveToCorruptFolder(file);
					//log("gSessionManager:cacheSessions: Cached " + session.filename + " in " + (Date.now() - a) + " milli-seconds.", "INFO");
				}
				else {
					this.timer.cancel();
					this.timer = null;
					convertFF3Sessions = false;
					log("gSessionManager:cacheSessions: Finished caching " + (cache_count - sessionFiles.length) + " session files" + (aSubFolder ? (" in " + aSubFolder) : "") + ".", "INFO");
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:startup-process-finished", encryption_mismatch ? "encryption_change_detected" : null)
				}
			}
		}
		
		log("convertFF3Sessions = " + convertFF3Sessions, "DATA");
		callback.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		callback.timer.initWithCallback(callback, 50, Ci.nsITimer.TYPE_REPEATING_SLACK);
	},

	// Use to update cache with new timestamp so we don't re-read it for no reason
	updateCachedLastModifiedTime: function(aFullFilePath, aLastModifiedTime) {
		if (mSessionCache[aFullFilePath]) {
			mSessionCache[aFullFilePath].time = aLastModifiedTime;
		}
	},

	//
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	// aSubFolder - optional sub-folder to look for sessions in.  Used to check "Deleted" folder.
	// aFilterByFileName - if set to true, then apply filter to filename instead of name
	//
	getSessions: function(filter, aSubFolder, aFilterByFileName)
	{
		let matchArray;
		let sessions = [];
		sessions.latestTime = sessions.latestBackUpTime = 0;
		
		let dir = this.getSessionDir(aSubFolder);
		if (!dir.exists() || !dir.isDirectory())
			return sessions;
		let filesEnum = dir.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
		let folderName = aSubFolder ? (aSubFolder + "/") : "";
		while (filesEnum.hasMoreElements())
		{
			let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
			// don't try to read a directory or it somehow just got deleted (delayed writing can do that, especially with backup sessions at shutdown)
			if (!file.exists() || file.isDirectory()) continue;
			let fileName = file.leafName;
			// Check here if filtering by filename as there's no reason to read the file if it's filtered.
			if (aFilterByFileName && filter && !filter.test(fileName)) continue;
			let backupItem = BACKUP_SESSION_REGEXP.test(fileName);
			let cached = mSessionCache[folderName + fileName] || null;
			if (cached && cached.time == file.lastModifiedTime)
			{
				try {
					if (filter && !aFilterByFileName && !filter.test(cached.name)) continue;
				} catch(ex) { 
					log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				if (!backupItem && (sessions.latestTime < cached.timestamp)) 
				{
					sessions.latestTime = cached.timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < cached.timestamp)) {
					sessions.latestBackUpTime = cached.timestamp;
				}
				sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp, autosave: cached.autosave, windows: cached.windows, tabs: cached.tabs, backup: backupItem, group: cached.group, encrypted: cached.encrypted });
				continue;
			}
			let session_header_data = this.readSessionFile(file, true);
			if (matchArray = SESSION_REGEXP.exec(session_header_data))
			{
				try {
					if (filter && !aFilterByFileName  && !filter.test(matchArray[1])) continue;
				} catch(ex) { 
					log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				let timestamp = parseInt(matchArray[2]) || file.lastModifiedTime;
				if (!backupItem && (sessions.latestTime < timestamp)) 
				{
					sessions.latestTime = timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < timestamp)) {
					sessions.latestBackUpTime = timestamp;
				}
				let group = matchArray[7] ? matchArray[7] : "";
				let encrypted = (session_header_data.split("\n")[4].indexOf(":") == -1);
				sessions.push({ fileName: fileName, name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group });
				// save mSessionCache data unless browser is shutting down
				if (!this._stopping) mSessionCache[folderName + fileName] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group, encrypted: encrypted };
			}
		}
		
		if (!this.mPref["session_list_order"])
		{
			this.mPref["session_list_order"] = gPreferenceManager.get("session_list_order", 1);
		}
		switch (Math.abs(this.mPref["session_list_order"]))
		{
		case 1: // alphabetically
			sessions = sessions.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
			break;
		case 2: // chronologically
			sessions = sessions.sort(function(a, b) { return a.timestamp - b.timestamp; });
			break;
		}
		
		return (this.mPref["session_list_order"] < 0)?sessions.reverse():sessions;
	},

	getClosedWindowsCount: function() {
		return this.getClosedWindows(true);
	},
	
	// Get SessionStore's or Session Manager's Closed window List depending on preference.
	// Return the length if the Length Only parameter is true - only ever true if not using built in closed window list
	getClosedWindows: function(aLengthOnly)
	{
		if (this.mUseSSClosedWindowList) {
			let closedWindows = this.JSON_decode(SessionStore.getClosedWindowData());
			if (aLengthOnly) return closedWindows.length;
			let parts = new Array(closedWindows.length);
			closedWindows.forEach(function(aWindow, aIx) {
				parts[aIx] = { name: aWindow.title, state: this.JSON_encode({windows:[aWindow]}) };
			}, this);
			return parts;
		}
		else {
			return this.getClosedWindows_SM(aLengthOnly);
		}
	},

	getClosedWindows_SM: function(aLengthOnly)
	{
		// Use cached data unless file has changed or was deleted
		let data = null;
		let file = this.getProfileFile(CLOSED_WINDOW_FILE);
		if (!file.exists()) return (aLengthOnly ? 0 : []);
		else if (file.lastModifiedTime > mClosedWindowCache.timestamp) {
			data = this.readFile(this.getProfileFile(CLOSED_WINDOW_FILE));
			data = data ? data.split("\n\n") : null;
			mClosedWindowCache.data = data;
			mClosedWindowCache.timestamp = (data ? file.lastModifiedTime : 0);
			if (aLengthOnly) return (data ? data.length : 0);
		}
		else {
			data = mClosedWindowCache.data;
		}
		if (aLengthOnly) {
			return (data ? data.length : 0);
		}
		else {
			return (data)?data.map(function(aEntry) {
				let parts = aEntry.split("\n");
				return { name: parts.shift(), state: parts.join("\n") };
			}):[];
		}
	},

	// Stored closed windows into Session Store or Session Manager controller list.
	storeClosedWindows: function(aWindow, aList, aIx)
	{
		if (this.mUseSSClosedWindowList) {
			// The following works in that the closed window appears to be removed from the list with no side effects
			let closedWindows = this.JSON_decode(SessionStore.getClosedWindowData());
			closedWindows.splice(aIx || 0, 1);
			let state = { windows: [ {} ], _closedWindows: closedWindows };
			SessionStore.setWindowState(aWindow, this.JSON_encode(state), false);
			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			SessionStore.setWindowValue(aWindow, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(aWindow, "SM_dummy_value");
		}
		else {
			this.storeClosedWindows_SM(aList);
		}
	},

	// Store closed windows into Session Manager controlled list
	storeClosedWindows_SM: function(aList)
	{
		let file = this.getProfileFile(CLOSED_WINDOW_FILE);
		if (aList.length > 0)
		{
			let data = aList.map(function(aEntry) {
				return aEntry.name + "\n" + aEntry.state
			});
			try {
				this.writeFile(file, data.join("\n\n"));
				mClosedWindowCache.data = data;
				mClosedWindowCache.timestamp = (data ? file.lastModifiedTime : 0);
			}
			catch(ex) {
				this.ioError(ex, CLOSED_WINDOW_FILE);
				return;
			}
		}
		else
		{
			try {
				this.delFile(file, false, true);
				mClosedWindowCache.data = null;
				mClosedWindowCache.timestamp = 0;
			}
			catch(ex) {
				this.ioError(ex, CLOSED_WINDOW_FILE);
				return;
			}
		}
		
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
		}
	},

	clearUndoData: function(aType, aSilent)
	{
		if (aType == "window" || aType == "all")
		{
			this.delFile(this.getProfileFile(CLOSED_WINDOW_FILE), aSilent, true);
		}
	},

	shutDown: function()
	{
		log("gSessionManager:shutDown start", "TRACE");
		
		// Make a backup of the current autosave values for use at startup if resuming last session
		if (this._pb_saved_autosave_values || gPreferenceManager.has("_autosave_values"))
			gPreferenceManager.set("_backup_autosave_values", (this._pb_saved_autosave_values || gPreferenceManager.get("_autosave_values")));
		
		// Handle sanitizing if sanitize on shutdown without prompting (only SeaMonkey ever prompts)
		let prompt = gPreferenceManager.get("privacy.sanitize.promptOnSanitize", null, true);
		let sanitize = (gPreferenceManager.get("privacy.sanitize.sanitizeOnShutdown", false, true) && 
		               (((prompt == false) && gPreferenceManager.get("privacy.item.extensions-sessionmanager", false, true)) ||
		                ((prompt == null) && gPreferenceManager.get("privacy.clearOnShutdown.extensions-sessionmanager", false, true))));

		if (sanitize)
		{
			this.sanitize();
		}
		// otherwise
		else
		{
			// If preference to clear save windows or using SessionStore closed windows, delete our closed window list
			if (!this.mPref["save_window_list"] || this.mUseSSClosedWindowList)
			{
				this.clearUndoData("window", true);
			}
			
			// Don't back up if in private browsing mode automatically via privacy preference
			// Allow back up if we started in private browsing mode and preferences are set correctly
			let nobackup = this.mAutoPrivacy && (this.mShutDownInPrivateBrowsingMode || this.isPrivateBrowserMode());
		
			// save the currently opened session (if there is one) otherwise backup if auto-private browsing mode not enabled
			// Only do backup processing if a browser window actually displayed (ie browser didn't exit before window displayed)
			if (!this.closeSession(false) && !nobackup)
			{
				if (this._browserWindowDisplayed) this.backupCurrentSession();
			}
			else
			{
				if (this._browserWindowDisplayed) this.keepOldBackups(false);
			}
			
			// Remove all auto_save sessions
			let sessions = this.getSessions(AUTO_SAVE_SESSION_REGEXP, false, true);
			sessions.forEach(function(aSession) {
				this.delFile(this.getSessionDir(aSession.fileName), true, true);
			}, this);
		}
		
		gPreferenceManager.delete("_autosave_values");
		this.mClosingWindowState = null;
		this.mTitle = this.old_mTitle;
		this._screen_width = null;
		this._screen_height = null;

		// Cleanup left over files from Crash Recovery
		if (gPreferenceManager.get("extensions.crashrecovery.resume_session_once", false, true))
		{	
			this.delFile(this.getProfileFile("crashrecovery.dat"), true, true);
			this.delFile(this.getProfileFile("crashrecovery.bak"), true, true);
			gPreferenceManager.delete("extensions.crashrecovery.resume_session_once", true);
		}
		this.setRunning(false);
		log("gSessionManager:shutDown end", "TRACE");
	},
	
	autoSaveCurrentSession: function(aForceSave)
	{
		try
		{
			if (aForceSave || !this.isPrivateBrowserMode()) {
				let state = this.getSessionState(this._string("autosave_session"), null, null, null, this._string("backup_sessions"));
				if (!state) return;
				// backup older autosave sessions
				this.keepOldBackups(true,true);
				this.writeFile(this.getSessionDir(AUTO_SAVE_SESSION_NAME), state, function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						gSQLManager.addSessionToSQLCache(false, AUTO_SAVE_SESSION_NAME);
					}
					else {
						let exception = new Components.Exception(AUTO_SAVE_SESSION_NAME, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioError(exception);
					}
				});
			}
		}
		catch (ex)
		{
			this.ioError(ex, AUTO_SAVE_SESSION_NAME);
		}
	},

	backupCurrentSession: function(aEnteringPrivateBrowsingMode, aPeriodicBackup)
	{
		log("backupCurrentSession start", "TRACE");
		let backup = this.mPref["backup_session"];
		
		// Force backup if a periodic backup
		if (aPeriodicBackup)
			backup = 1;

		// Don't automatically backup and restore if user chose to quit.
		let temp_backup = (this.mPref["startup"] == 2) && (this.mPref["resume_session"] == BACKUP_SESSION_FILENAME);

		// Get results from prompt in component if it was displayed and set the value back to the default
		let results = this.mShutdownPromptResults;
		log("backupCurrentSession: results = " + results, "DATA");
		if (results != -1) this.mShutdownPromptResults = -1;
		
		// If prompting for backup, read values from Component if they exist, else prompt here
		if (backup == 2)
		{
			// If there was no prompt in Component (older browser), prompt here
			let dontPrompt = { value: false };
			if (results == -1) {
				let saveRestore = !(gPreferenceManager.get("browser.sessionstore.resume_session_once", false, true) || this.doResumeCurrent() || aEnteringPrivateBrowsingMode);
				let flags = PROMPT_SERVICE.BUTTON_TITLE_SAVE * PROMPT_SERVICE.BUTTON_POS_0 + 
							PROMPT_SERVICE.BUTTON_TITLE_DONT_SAVE * PROMPT_SERVICE.BUTTON_POS_1 + 
							(saveRestore ? (PROMPT_SERVICE.BUTTON_TITLE_IS_STRING * PROMPT_SERVICE.BUTTON_POS_2) : 0); 
				results = PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string("preserve_session"), flags,
			              null, null, this._string("save_and_restore"), this._string("prompt_not_again"), dontPrompt);
			}
			// If quit was pressed, skip all the session stuff below
			backup = (results == 1)?-1:1;
			switch(results) {
				case 2:	// If chose Save & Restore
					if (dontPrompt.value) {
						gPreferenceManager.set("resume_session", BACKUP_SESSION_FILENAME);
						gPreferenceManager.set("startup", 2);
					}
					else gPreferenceManager.set("restore_temporary", true);
					break;
				case 1: // If chose Quit
					// If set to restore previous session and chose to quit and remember, set startup to "none"
					if (dontPrompt.value && temp_backup) {
						gPreferenceManager.set("startup", 0);
					}
					// Don't temporarily restore
					temp_backup = false;
					break;
			}
			if (dontPrompt.value)
			{
				gPreferenceManager.set("backup_session", (backup == -1)?0:1);
			}
		}
		
		log("backupCurrentSession: backup = " + backup + ", temp_backup = " + temp_backup, "DATA");
		
		// Don't save if just a blank window, if there's an error parsing data, just save
		let state = null;
		if ((backup > 0) || temp_backup) {
			// If shut down in private browsing mode, use the pre-private sesssion, otherwise get the current one
			let helper_state = (this.mShutDownInPrivateBrowsingMode || this.isPrivateBrowserMode()) ? this.mBackupState : null;
			log("backupCurrentSession: helper_state = " + helper_state, "DATA");
		
			try {
				state = this.getSessionState(this._string("backup_session"), null, this.getNoUndoData(), null, this._string("backup_sessions"), true, null, helper_state);
			} catch(ex) {
				logError(ex);
			}
			try {
				let aState = this.JSON_decode(state.split("\n")[4]);
				log("backupCurrentSession: Number of Windows #1 = " + aState.windows.length + ((aState.windows.length >= 1) ? (", Number of Tabs in Window[1] = " + aState.windows[0].tabs.length) : ""), "DATA");
				log(state, "STATE");
				// if window data has been cleared ("Visited Pages" cleared on shutdown), use mClosingWindowState, if it exists.
				if ((aState.windows.length == 0 || (aState.windows.length >= 1 && aState.windows[0].tabs.length == 0)) && (this.mClosingWindowState || mShutdownState)) {
					log("backupCurrentSession: Using " + (this.mClosingWindowState ? "closing Window State" :"Shutdown state"), "INFO");
					state = this.getSessionState(this._string("backup_session"), null, this.getNoUndoData(), null, this._string("backup_sessions"), true, null, this.mClosingWindowState || mShutdownState);
					log(state, "STATE");
					aState = this.JSON_decode(state.split("\n")[4]);
				}
				log("backupCurrentSession: Number of Windows #2 = " + aState.windows.length, "DATA");
				// If there isn't any actual session data, don't do a backup - closed window data is considered session data
				if ((!aState._closedWindows || aState._closedWindows.length == 0) && 
				    ((aState.windows.length == 0) || 
				     !((aState.windows.length > 1) || (aState.windows[0]._closedTabs.length > 0) || 
				       (aState._closedWindows && aState._closedWindows.length > 0) ||
				       (aState.windows[0].tabs.length > 1) || (aState.windows[0].tabs[0].entries.length > 1) || 
				       ((aState.windows[0].tabs[0].entries.length == 1 && aState.windows[0].tabs[0].entries[0].url != "about:blank"))
				    ))) {
					backup = 0;
					temp_backup = false;
				}
			} catch(ex) { 
				logError(ex);
			}
		}

		if (backup > 0 || temp_backup)
		{
			this.keepOldBackups(backup > 0);
			
			// encrypt state if encryption preference set
			if (this.mPref["encrypt_sessions"]) {
				state = state.split("\n")
				state[4] = this.decryptEncryptByPreference(state[4]);
				if (!state[4]) return;
				state = state.join("\n");
			}
			
			try
			{
				this.writeFile(this.getSessionDir(BACKUP_SESSION_FILENAME), state, function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						gSQLManager.addSessionToSQLCache(false, BACKUP_SESSION_FILENAME);
					}
					else {
						let exception = new Components.Exception(BACKUP_SESSION_FILENAME, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioError(exception);
					}
				});
				if (temp_backup && (backup <= 0)) gPreferenceManager.set("backup_temporary", true);
			}
			catch (ex)
			{
				this.ioError(ex, BACKUP_SESSION_FILENAME);
			}
		}
		else this.keepOldBackups(false);
		log("backupCurrentSession end", "TRACE");
	},

	keepOldBackups: function(backingUp, aAutoSaveBackup)
	{
		log("keepOldBackups start for " + (aAutoSaveBackup ? "autosave" : "backup"), "TRACE");
		if (!backingUp && (this.mPref["max_backup_keep"] > 0)) this.mPref["max_backup_keep"] = this.mPref["max_backup_keep"] + 1; 
		let backup = this.getSessionDir(aAutoSaveBackup ? AUTO_SAVE_SESSION_NAME : BACKUP_SESSION_FILENAME);
		if (backup.exists()) {
			if (aAutoSaveBackup || this.mPref["max_backup_keep"])
			{
				let oldBackup = this.getSessionDir(aAutoSaveBackup ? AUTO_SAVE_SESSION_NAME : BACKUP_SESSION_FILENAME, true);
				// preserve date that file was backed up
				let date = new Date();
				date.setTime(backup.lastModifiedTime); 
				let name = this.getFormattedName("", date, this._string(aAutoSaveBackup ? "old_autosave_session" : "old_backup_session"));
				this.writeFile(oldBackup, this.nameState(this.readSessionFile(backup), name), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Update SQL cache file
						gSQLManager.addSessionToSQLCache(false, oldBackup.leafName);
					}
					else {
						let exception = new Components.Exception(oldBackup.leafName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioError(exception);
					}
				});
			}
			if (!backingUp)
				this.delFile(backup, true, true);
		}	
		
		// Prune backed up sessions down to max keep value.  Does not apply to autosave sessions
		if (!aAutoSaveBackup && this.mPref["max_backup_keep"] != -1)
		{
			this.getSessions().filter(function(aSession) {
				return /^backup-\d+\.session$/.test(aSession.fileName);
			}).sort(function(a, b) {
				return b.timestamp - a.timestamp;
			}).slice(this.mPref["max_backup_keep"]).forEach(function(aSession) {
				this.delFile(this.getSessionDir(aSession.fileName), true);
			}, this);
		}
		log("keepOldBackups end", "TRACE");
	},

	readSessionFile: function(aFile,headerOnly,aSyncCallback, aDoNotProcess)
	{
		try {
			// Since there's no way to really actually read only the first few lines in a file with an
			// asynchronous read, we do header only reads synchronously.
			if (typeof aSyncCallback == "function") {
				this.asyncReadFile(aFile, function(aInputStream, aStatusCode) {
					if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
						// Read the session file from the stream and process and return it to the callback function
						let is = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
						is.init(aInputStream);
						let state = is.read(headerOnly ? 1024 : aInputStream.available());
						is.close();
						aInputStream.close();
						let utf8Converter = Cc["@mozilla.org/intl/utf8converterservice;1"].getService(Ci.nsIUTF8ConverterService);
						// Sometimes this may throw with a "0x8050000e [nsIUTF8ConverterService.convertURISpecToUTF8] = <unknown>" (Antivirus maybe?) error so catch
						try {
							state = utf8Converter.convertURISpecToUTF8 (state, "UTF-8");
						}
						catch(ex) {
							// Just log as it seems the error doesn't appear to affect anything
							logError("Error converting to UTF8 for " + aFile.leafName);
							logError(ex);
						}
						state = state.replace(/\r\n?/g, "\n");
						if (!aDoNotProcess)
							state = processReadSessionFile(state, aFile, headerOnly, aSyncCallback);
						if (state) aSyncCallback(state);
					}
				});
				return null;
			}
			else {
				let state = this.readFile(aFile,headerOnly);
				return processReadSessionFile(state, aFile, headerOnly);
			}
		}
		catch(ex) {
			logError(ex, true);
			return null;
		}
	},
	
	asyncReadFile: function(aFile, aCallback)
	{
		let fileURI = IO_SERVICE.newFileURI(aFile);
		let channel = IO_SERVICE.newChannelFromURI(fileURI);
		
		NetUtil.asyncFetch(channel, aCallback);
	},
	
	readFile: function(aFile,headerOnly)
	{
		try
		{
			let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
			stream.init(aFile, 0x01, 0, 0);
			let cvstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
			cvstream.init(stream, "UTF-8", 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
			
			let content = "";
			let data = {};
			while (cvstream.readString(4096, data))
			{
				content += data.value;
				if (headerOnly) break;
			}
			cvstream.close();
			
			return content.replace(/\r\n?/g, "\n");
		}
		catch (ex) { }
		
		return null;
	},

	writeFile: function(aFile, aData, aCallback)
	{
		if (!aData) return;  // this handles case where data could not be encrypted and null was passed to writeFile
		aData = aData.replace(/\n/g, _EOL);  // Change EOL for OS
		// safe-file-output-streams don't work when overwriting files with unicode characters in the file name in Firefox 3.6
		// Bug 629291 - https://bugzilla.mozilla.org/show_bug.cgi?id=629291
		let ostream = (gecko2plus) ? Cc["@mozilla.org/network/safe-file-output-stream;1"].createInstance(Ci.nsIFileOutputStream) 
		                           : Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		ostream.init(aFile, 0x02 | 0x08 | 0x20, 0600, 0);
		let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
		converter.charset = "UTF-8";
		
		// Asynchronously copy the data to the file.
		let istream = converter.convertToInputStream(aData);
		NetUtil.asyncCopy(istream, ostream, aCallback);
	},

	delFile: function(aFile, aSilent, aDeleteOnly)
	{
		if (aFile && aFile.exists())
		{
			try
			{
				// remove from SQL Cache if not deleting cache file itself (other files not in cache will be okay)
				// Also don't remove files in the deleted folder since they won't be added and deleting them can cause
				// items from the cache to be removed if the filename is the same as one in the sessions folder
				if ((aFile.leafName != SESSION_SQL_FILE) && (aFile.parent.leafName != this._string("deleted_sessions_folder")))
					gSQLManager.removeSessionFromSQLCache(aFile.leafName);
			
				if (aDeleteOnly || (gPreferenceManager.get("recycle_time", 7) <= 0)) {
					aFile.remove(false);
					if (aFile.parent) {
						if (aFile.parent.leafName == this.getSessionDir().leafName)
							delete mSessionCache[aFile.leafName];
						else 
							delete mSessionCache[aFile.parent.leafName + "/" + aFile.leafName];
					}
				}
				else {
					aFile.lastModifiedTime = Date.now();
					let folder = this._string("deleted_sessions_folder");
					this.moveToFolder(aFile, folder);
				}
			}
			catch (ex)
			{
				if (!aSilent)
				{
					this.ioError(ex, (aFile ? aFile.leafName : ""));
				}
				else logError(ex);
			}
		}
		
		this.purgeOldDeletedSessions();
	},
	
	restoreDeletedSessionFile: function(aFile, aSilent)
	{
		if (aFile && aFile.exists())
		{
			try
			{
				this.moveToFolder(aFile);
				gSQLManager.addSessionToSQLCache(false, aFile.leafName);
			}
			catch (ex)
			{
				if (!aSilent)
				{
					this.ioError(ex, (aFile ? aFile.leafName : ""));
				}
				else logError(ex);
			}
		}
	},
	
	// Purge old deleted sessions when they get too old.  This function will check on program startup 
	// and then at most every 24 hours (triggered by a call to delfile).
	purgeOldDeletedSessions: function() {
		let time = Date.now();
		// if current time is greater than the last checked time + 24 hours (in milliseconds)
		if (time > (_lastCheckedTrashForRemoval + 86400000)) {
			_lastCheckedTrashForRemoval = time;
			
			// Set time to "recycle_time" days ago
			time = time - gPreferenceManager.get("recycle_time", 7) * 86400000;
			
			// Get trash folder, if it doesn't exist exit
			let dir = this.getSessionDir(this._string("deleted_sessions_folder"));
			if (!dir.exists()) return;
			
			// Permanently delete any old files in the trash folder
			let filesEnum = dir.directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
			while (filesEnum.hasMoreElements())
			{
				let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
				if (file.lastModifiedTime < time) {
					this.delFile(file, true, true);
				}
			}
		}
	},
	
	emptyTrash: function() {
		let dontPrompt = { value: false };
		if (gPreferenceManager.get("no_empty_trash_prompt") || PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string("empty_trash_prompt"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			let dir = this.getSessionDir(this._string("deleted_sessions_folder"));
			try
			{
				dir.remove(true);
			}
			catch (ex)
			{
				this.ioError(ex, (dir ? dir.path : ""));
			}
			if (dontPrompt.value)
			{
				gPreferenceManager.set("no_empty_trash_prompt", true);
			}
		}
	},
	
	moveToCorruptFolder: function(aFile, aSilent)
	{
		try {
			if (aFile.exists()) 
			{
				this.moveToFolder(aFile, this._string("corrupt_sessions_folder"), true);
			}
		}	
		catch (ex) { 
			if (!aSilent && !this._stopping) this.ioError(ex, (aFile ? aFile.leafName : ""));
			else logError(ex);
		}
	},
	
	moveToFolder: function(aFile, aFolderName, aOverwrite)
	{
		let dir = this.getSessionDir(aFolderName);
		let old_parentname = aFile.parent ? aFile.parent.leafName : "";
		let old_name = aFile.leafName;
		let new_name = null;
	
		if (!dir.exists()) {
			dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
		}

		// check to see if file with same name exists and if so rename file
		if (!aOverwrite) {
			let newFile = dir.clone();
			newFile.append(aFile.leafName);
			if (newFile.exists()) 
				new_name = this.makeUniqueSessionFileName(newFile, newFile.leafName).leafName;
		}
		
		aFile.moveTo(dir, new_name);
		
		// move to correct cache area using new name (if name changed)
		if (aFolderName && mSessionCache[old_name]) {
			mSessionCache[aFolderName + "/" + (new_name || old_name)] = mSessionCache[old_name];
			delete mSessionCache[old_name];
		}
		else if (!aFolderName && mSessionCache[old_parentname + "/" + old_name]) {
			mSessionCache[new_name || old_name] = mSessionCache[old_parentname + "/" + old_name];
			delete mSessionCache[old_parentname + "/" + old_name];
		}
	},
	
/* ........ Encryption functions .............. */

	cryptError: function(aException, notSaved)
	{
		let text;
		if (aException.message) {
			if (aException.message.indexOf("decryptString") != -1) {
				if (aException.name != "NS_ERROR_NOT_AVAILABLE") {
					text = this._string("decrypt_fail1");
				}
				else {
					text = this._string("decrypt_fail2");
				}
			}
			else {
				text = notSaved ? this._string("encrypt_fail2") : this._string("encrypt_fail");
			}
		}
		else text = aException;
		this.threadSafeAlert(text);
	},

	decrypt: function(aData, aNoError, doNotDecode)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		if (aData.indexOf(":") == -1)
		{
			try {
				aData = SECRET_DECODER_RING_SERVICE.decryptString(aData);
				if (!doNotDecode) aData = decodeURIComponent(aData);
			}
			catch (ex) { 
				logError(ex);
				if (!aNoError) this.cryptError(ex); 
				// encrypted file corrupt, return false so as to not break things checking for aData.
				if (ex.name != "NS_ERROR_NOT_AVAILABLE") { 
					return false;
				}
				return null;
			}
		}
		return aData;
	},

	// This function will encrypt the data if the encryption preference is set.
	// It will also decrypt encrypted data if the encryption preference is not set.
	decryptEncryptByPreference: function(aData, aSilent, aReturnOriginalStateOnError)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		let encrypted = (aData.indexOf(":") == -1);
		try {
			if (this.mPref["encrypt_sessions"] && !encrypted)
			{
				aData = SECRET_DECODER_RING_SERVICE.encryptString(encodeURIComponent(aData));
			}
			else if (!this.mPref["encrypt_sessions"] && encrypted)
			{
				aData = decodeURIComponent(SECRET_DECODER_RING_SERVICE.decryptString(aData));
			}
		}
		catch (ex) { 
			if (!aSilent) {
				if (!encrypted && this.mPref["encrypted_only"]) {
					this.cryptError(ex, true);
					return null;
				}
				else this.cryptError(ex);
			}
			else {
				logError(ex);
				if (!aReturnOriginalStateOnError)
					return ex;
			}
		}
		return aData;
	},
	
	encryptionChange: function()
	{
		// force a master password prompt so we don't waste time if user cancels it
		if (PasswordManager.enterMasterPassword()) 
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:encryption-change", "start");
		// failed to encrypt/decrypt so revert setting
		else {
			gPreferenceManager.set("encrypt_sessions",!this.mPref["encrypt_sessions"]);
			this.cryptError(this._string("change_encryption_fail"));
		}
	},
/* ........ Conversion functions .............. */

	convertEntryToLatestSessionFormat: function(aEntry)
	{
		// Convert Postdata
		if (aEntry.postdata) {
			aEntry.postdata_b64 = btoa(aEntry.postdata);
		}
		delete aEntry.postdata;
	
		// Convert owner
		if (aEntry.ownerURI) {
			let uriObj = IO_SERVICE.newURI(aEntry.ownerURI, null, null);
			let owner = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager).getCodebasePrincipal(uriObj);
			try {
				let binaryStream = Cc["@mozilla.org/binaryoutputstream;1"].
								   createInstance(Ci.nsIObjectOutputStream);
				let pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
				pipe.init(false, false, 0, 0xffffffff, null);
				binaryStream.setOutputStream(pipe.outputStream);
				binaryStream.writeCompoundObject(owner, Ci.nsISupports, true);
				binaryStream.close();

				// Now we want to read the data from the pipe's input end and encode it.
				let scriptableStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
				scriptableStream.setInputStream(pipe.inputStream);
				let ownerBytes = scriptableStream.readByteArray(scriptableStream.available());
				// We can stop doing base64 encoding once our serialization into JSON
				// is guaranteed to handle all chars in strings, including embedded
				// nulls.
				aEntry.owner_b64 = btoa(String.fromCharCode.apply(null, ownerBytes));
			}
			catch (ex) { logError(ex); }
		}
		delete aEntry.ownerURI;
	
		// convert children
		if (aEntry.children) {
			for (var i = 0; i < aEntry.children.length; i++) {
				//XXXzpao Wallpaper patch for bug 514751
				if (!aEntry.children[i].url)
					continue;
				aEntry.children[i] = this.convertEntryToLatestSessionFormat(aEntry.children[i]);
			}
		}
		
		return aEntry;
	},
	
	convertTabToLatestSessionFormat: function(aTab)
	{
		// Convert XULTAB to attributes
		if (aTab.xultab) {
			if (!aTab.attributes) aTab.attributes = {};
			// convert attributes from the legacy Firefox 2.0/3.0 format
			aTab.xultab.split(" ").forEach(function(aAttr) {
				if (/^([^\s=]+)=(.*)/.test(aAttr)) {
					aTab.attributes[RegExp.$1] = RegExp.$2;
				}
			}, this);
		}
		delete aTab.xultab;

		// Convert text data
		if (aTab.text) {
			if (!aTab.formdata) aTab.formdata = {};
			let textArray = aTab.text ? aTab.text.split(" ") : [];
			textArray.forEach(function(aTextEntry) {
				if (/^((?:\d+\|)*)(#?)([^\s=]+)=(.*)$/.test(aTextEntry)) {
					let key = RegExp.$2 ? "#" + RegExp.$3 : "//*[@name='" + RegExp.$3 + "']";
					aTab.formdata[key] = RegExp.$4;
				}
			});
		}
		delete aTab.text;
		
		// Loop and convert entries
		aTab.entries.forEach(function(aEntry) {
			aEntry = this.convertEntryToLatestSessionFormat(aEntry);
		}, this);
		
		return aTab;
	},
	
	convertWindowToLatestSessionFormat: function(aWindow)
	{
		// Loop tabs
		aWindow.tabs.forEach(function(aTab) {
			aTab = this.convertTabToLatestSessionFormat(aTab);
		}, this);
		
		// Loop closed tabs
		if (aWindow._closedTabs) {
			aWindow._closedTabs.forEach(function(aTab) {
				aTab.state = this.convertTabToLatestSessionFormat(aTab.state);
			}, this);
		}
		return aWindow;
	},

	convertToLatestSessionFormat: function(aFile, aState)
	{
		log("Converting " + aFile.leafName + " to latest format", "TRACE");
		
		let state = aState.split("\n");
		// decrypt if encrypted, do not decode if in old format since old format was not encoded
		state[4] = this.decrypt(state[4], true);
		
		// convert to object
		state[4] = this.JSON_decode(state[4], true);
		
		// Loop and convert windows
		state[4].windows.forEach(function(aWindow) {
			aWindow = this.convertWindowToLatestSessionFormat(aWindow);
		}, this);

		// Loop and convert closed windows
		if (state[4]._closedWindows) {
			state[4]._closedWindows.forEach(function(aWindow) {
				aWindow = this.convertWindowToLatestSessionFormat(aWindow);
			}, this);
		}
		
		// replace state
		state[4] = this.JSON_encode(state[4]);
		state[4] = this.decryptEncryptByPreference(state[4], true, true);
		state = state.join("\n");
		
		// Make a backup of old session in case something goes wrong
		try {
			if (aFile.exists()) 
			{
				let newFile = aFile.clone();
				this.moveToFolder(newFile, this._string("older_format_sessions_folder"));
			}
		}	
		catch (ex) { 
			logError(ex); 
		}
		
		// Save session
		this.writeFile(aFile, state);

		return state;
	},

	decodeOldFormat: function(aIniString, moveClosedTabs)
	{
		let rootObject = {};
		let obj = rootObject;
		let lines = aIniString.split("\n");
	
		for (let i = 0; i < lines.length; i++)
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
		let names = aLine.split("]")[0].substr(1).split(".");
	
		for (let i = 0; i < names.length; i++)
		{
			if (!names[i])
			{
				throw new Error("Invalid header: [" + names.join(".") + "]!");
			}
			if (/(\d+)$/.test(names[i]))
			{
				names[i] = names[i].slice(0, -RegExp.$1.length);
				let ix = parseInt(RegExp.$1) - 1;
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
		let ix = aLine.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aLine + "!");
		}
	
		let value = aLine.substr(ix + 1);
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
		
		let name = this.ini_fixName(aLine.substr(0, ix));
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
		let ClosedTabObject = {};
		let ix = aCloseTabData.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aCloseTabData + "!");
		}
		let serializedTabs = aCloseTabData.substr(ix + 1);
		serializedTabs = decodeURI(serializedTabs.replace(/%3B/gi, ";"));
		let closedTabs = serializedTabs.split("\f\f").map(function(aData) {
			if (/^(\d+) (.*)\n([\s\S]*)/.test(aData))
			{
				return { name: RegExp.$2, pos: parseInt(RegExp.$1), state: RegExp.$3 };
			}
			return null;
		}).filter(function(aTab) { return aTab != null; }).slice(0, gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true));

		closedTabs.forEach(function(aValue, aIndex) {
			closedTabs[aIndex] = this.decodeOldFormat(aValue.state, false)
			closedTabs[aIndex] = closedTabs[aIndex].windows;
			closedTabs[aIndex] = closedTabs[aIndex][0].tabs;
		}, this);

		aObj["_closedTabs"] = [];

		closedTabs.forEach(function(aValue, aIndex) {
			aObj["_closedTabs"][aIndex] = this.JSON_decode({ state : this.JSON_encode(aValue[0]) });
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

/* ........ Miscellaneous Enhancements .............. */

	// Check for Running
	isRunning: function() {
		return Application.storage.get("sessionmanager._running", false);
	},
	
	// Check for Running
	setRunning: function(aValue) {
		return Application.storage.set("sessionmanager._running", aValue);
	},

	// Read Autosave values from preference and store into global variables
	getAutoSaveValues: function(aValues, aWindow)
	{
		if (!aValues) aValues = "";
		let values = aValues.split("\n");
		log("getAutoSaveValues: aWindow = " + (aWindow ? aWindow.content.document.title : "null") + ", aValues = " + values.join(", "), "EXTRA");
		if (aWindow) {
			let old_window_session_filename = aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename;
			let old_window_session_time = aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_time;
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename = values[0];
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_name = values[1];
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_group = values[2];
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_time = isNaN(values[3]) ? 0 : values[3];
			try {
				// This throws whenever a window is already closed (during shutdown for example) or if the value doesn't exist and we try to delete it
				if (aValues) {
					// Store window session into Application storage and set window value
					this.mActiveWindowSessions[values[0]] = true;
					SessionStore.setWindowValue(aWindow, "_sm_window_session_values", aValues);
				}
				else {
					if (old_window_session_filename) {
						// Remove window session from Application storage and delete window value
						delete this.mActiveWindowSessions[old_window_session_filename];
					}
					SessionStore.deleteWindowValue(aWindow, "_sm_window_session_values");
					
					// the following forces SessionStore to save the state to disk (bug 510965)
					// Can't just set _sm_window_session_values to "" and then delete since that will throw an exception
					SessionStore.setWindowValue(aWindow, "SM_dummy_value","1");
					SessionStore.deleteWindowValue(aWindow, "SM_dummy_value");
				}
			}
			catch(ex) {
				// log it so we can tell when things aren't working.  Don't log exceptions in deleteWindowValue
				// because it throws an exception if value we are trying to delete doesn't exist. Since we are 
				// deleting the value, we don't care if it doesn't exist.
				if (ex.message.indexOf("deleteWindowValue") == -1) logError(ex);
			}
			
			// start/stop window timer
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.checkWinTimer(old_window_session_time);
			OBSERVER_SERVICE.notifyObservers(aWindow, "sessionmanager:updatetitlebar", null);
		}
		else {
			this.mPref["_autosave_filename"] = values[0];
			this.mPref["_autosave_name"] = values[1];
			this.mPref["_autosave_group"] = values[2];
			this.mPref["_autosave_time"] = isNaN(values[3]) ? 0 : values[3];
		}

		// Update tab tree if it's open
		OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
	},

	// Merge autosave variables into a a string
	mergeAutoSaveValues: function(filename, name, group, time)
	{
		let values = [ filename, name, group, isNaN(time) ? 0 : time ];
		return values.join("\n");
	},
	
	// Called to handle clearing of private data (stored sessions) when the toolbar item is selected
	// and when the clear now button is pressed in the privacy options pane.  If the option to promptOnSanitize
	// is set, this function ignores the request and let's the Firefox Sanitize function call
	// gSessionManager.santize when Clear Private Data okay button is pressed and Session Manager's checkbox
	// is selected.  This is only called in SeaMonkey.
	tryToSanitize: function()
	{
		// User disabled the prompt before clear option and session manager is checked in the privacy data settings
		if ( !gPreferenceManager.get("privacy.sanitize.promptOnSanitize", true, true) &&
			 gPreferenceManager.get("privacy.item.extensions-sessionmanager", false, true) ) 
		{
			gSessionManager.sanitize();
			return true;
		}
	
		return false;
	},
	
	// This returns an autosave session that was saved when the browser shut instead of the normal backup session
	getAutoSaveSessionNewerThanLastBackupSession: function()
	{
		let session = null;
		let sessions = this.getSessions();
		// if latest user saved session newer than latest backup session
		if (sessions.latestBackUpTime < sessions.latestTime) {
			// find latest session if it's an autosave session
			session = sessions.filter(function(element, index, array) {  
				return ((sessions.latestTime == element.timestamp) && /^session/.exec(element.autosave));  
			})[0];
			if (session) 
				session = session.fileName;
		}
		return session;
	},
		
	recoverSession: function(aWindow)
	{
		let file, temp_restore = null, first_temp_restore = null, temp_restore_index = 1;
		// Use SessionStart's value because preference is cleared by the time we are called
		let sessionstart = !this.mAlreadyShutdown && SessionStartup.doRestore();
		let recoverOnly = this.isRunning() || sessionstart || this._no_prompt_for_session;
		this._no_prompt_for_session = false;
		log("recoverSession: recovering = " + (this._recovering ? this._recovering.fileName : "null") + ", sessionstart = " + sessionstart + ", recoverOnly = " + recoverOnly, "DATA");
		if (typeof(this._temp_restore) == "string") {
			log("recoverSession: command line session data = \"" + this._temp_restore + "\"", "DATA");
			temp_restore = this._temp_restore.split("\n");
			first_temp_restore = temp_restore[1];
		}
		this._temp_restore = null;

		// handle crash where user chose a specific session
		if (this._recovering)
		{
			let recovering = this._crash_session_filename = this._recovering.fileName;
			let sessionState = this._recovering.sessionState;
			this._recovering = null;
			this.load(aWindow, recovering, "startup", sessionState);
			// Clear out return data and preset to not accepting
			this.sessionPromptReturnData = null;
		}
		else if (!recoverOnly && (this.mPref["restore_temporary"] || first_temp_restore || (this.mPref["startup"] == 1) || ((this.mPref["startup"] == 2) && this.mPref["resume_session"])) && this.getSessions().length > 0)
		{
			// allow prompting for tabs
			let values = { ignorable: true, preselect: this.mPref["preselect_previous_session"], no_parent_window: true, startupPrompt: true };
			
			// Order preference:
			// 1. Temporary backup session
			// 2. Prompt or selected session
			// 3. Command line session.
			let session = (this.mPref["restore_temporary"])?BACKUP_SESSION_FILENAME:((this.mPref["startup"] == 1)?this.selectSession(this._string("resume_session"), this._string("resume_session_ok"), values):
			              ((this.mPref["startup"] == 2)?this.mPref["resume_session"]:first_temp_restore));
			// If no session chosen to restore, use the command line specified session
			if (!session) session = first_temp_restore;
			if (session && (session == first_temp_restore)) {
				log("recoverSession: Restoring startup command line session \"" + first_temp_restore + "\"", "DATA");
				// Go to next command line item if it exists
				temp_restore_index++;
			}
			log("recoverSession: Startup session = " + session, "DATA");
			// If restoring backup session and we already shutdown (meaning last closed window closed but browser did not exit) simply unclose the last window
			if (this.mAlreadyShutdown && (session == BACKUP_SESSION_FILENAME)) {
				log("recoverSession: Opening last closed window or let browser do it", "TRACE");
				// If browser preference set to restore windows and tabs, don't do anything as the browser will take care of restoring the window.
				if (!this.doResumeCurrent())
					this.undoCloseWindow();
			}
			else if (session && (file = this.getSessionDir(session)) && (file.exists() || (session == BACKUP_SESSION_FILENAME)))
			{
				// If user chooses to restore backup session, but there is no backup session, then an auto-save session was open when 
				// browser closed so restore that. 
				let autosave_backup = this.getAutoSaveSessionNewerThanLastBackupSession();
				if (autosave_backup) {
					if (!file.exists())
						log("recoverSession: Backup session not found, using autosave session = " + session, "DATA");
					this._restoring_autosave_backup_session = true;
				}
				if (session == BACKUP_SESSION_FILENAME) this._restoring_backup_session = true;
				if (session) this.load(aWindow, session, "startup", values.sessionState);
				else log("recoverSession: Backup session not found.", "TRACE");
			}
			// if user set to resume previous session, don't clear this so that way user can choose whether to backup
			// current session or not and still have it restore.
			else if ((this.mPref["startup"] == 2) && (this.mPref["resume_session"] != BACKUP_SESSION_FILENAME)) {
				gPreferenceManager.set("resume_session",BACKUP_SESSION_FILENAME);
				gPreferenceManager.set("startup",0);
			}
			if (values.ignore)
			{
				gPreferenceManager.set("resume_session", session || BACKUP_SESSION_FILENAME);
				gPreferenceManager.set("startup", (session)?2:0);
			}
			// For some reason if the browser was already running (closed last window, but didn't exit browser) and we prompt for a session, but
			// don't actually load a session and the browser restores the tabs, the selected tab will change to "about:blank". 
			if (this.mAlreadyShutdown && (this.mPref["startup"] == 1) && this.doResumeCurrent() && (!session || (session == BACKUP_SESSION_FILENAME))) {
				log("recoverSession: Session Manager prompted for session, but browser restored tabs so fix about:blank issue.", "TRACE");
				aWindow.setTimeout(function() { aWindow.gBrowser.gotoIndex(0) }, 0);
			}
			// Display Home Page if user selected to do so
			//if (display home page && this.isCmdLineEmpty(aWindow)) {
			//	BrowserHome();
			//}
		}
		// handle browser reload with same session and when opening new windows
		else if (recoverOnly) {
			this.checkAutoSaveTimer();
		}
		
		// Not shutdown 
		this.mAlreadyShutdown = false;
		
		// If browser restored last session and there was an autosave session, resume it
		if (sessionstart) {
			let last_autosave_session = gPreferenceManager.get("_backup_autosave_values", null);
			if (last_autosave_session) {
				gPreferenceManager.set("_autosave_values", last_autosave_session);
				log("recoverSession: browser restored last session, restored autosave session = " + last_autosave_session, "DATA");
			}
		}
		
		// Remove any backed up autosave values
		gPreferenceManager.delete("_backup_autosave_values");
		
		// Restore command line specified session(s) in a new window if they haven't been restored already
		if (first_temp_restore) {
			// For each remaining session in the command line
			while (temp_restore.length > temp_restore_index) {
				file = this.getSessionDir(temp_restore[temp_restore_index]);
				if (file && file.exists()) {
					log("recoverSession: Restoring additional command line session " + temp_restore_index + " \"" + temp_restore[temp_restore_index] + "\"", "DATA");
					// Only restore into existing window if not startup and first session in command line
					this.load(aWindow, temp_restore[temp_restore_index], (((temp_restore_index > 1) || (temp_restore[0] == "0")) ? "newwindow_always" : "overwrite_window"));
				}
				temp_restore_index++;
			}
		}
		
		// If need to encrypt backup file, do it
		// Even though we now check for encryption during session caching, on a crash the cache will already
		// have been created so it won't check again until the next browser restart so just encrypt manually here.
		if (this._encrypt_file) {
			let file = this.getSessionDir(this._encrypt_file);
			this._encrypt_file = null;
			this.readSessionFile(file, false, function(state) {
				if (state) 
				{
					if (SESSION_REGEXP.test(state))
					{
						state = state.split("\n")
						state[4] = gSessionManager.decryptEncryptByPreference(state[4]);
						// if could be encrypted or encryption failed but user allows unencrypted sessions
						if (state[4]) {
							// if encrypted save it
							if (state[4].indexOf(":") == -1) {
								state = state.join("\n");
								gSessionManager.writeFile(file, state);
							}
						}
						// couldn't encrypt and user does not want unencrypted files so delete it
						else gSessionManager.delFile(file);
					}
					else gSessionManager.delFile(file, false, true);
				}
			});
		}
	},

	isCmdLineEmpty: function(aWindow)
	{
		if (Application.name.toUpperCase() != "SEAMONKEY") {
			try {
				// Use the defaultArgs, unless SessionStore was trying to resume or handle a crash.
				// This handles the case where the browser updated and SessionStore thought it was supposed to display the update page, so make sure we don't overwrite it.
				let defaultArgs = (SessionStartup.doRestore()) ? 
				                  Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).startPage :
				                  Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).defaultArgs;
				if (aWindow.arguments && aWindow.arguments[0] && aWindow.arguments[0] == defaultArgs) {
					aWindow.arguments[0] = null;
				}
				return !aWindow.arguments || !aWindow.arguments[0];
			}
			catch(ex) {
				logError(ex);
				return false;
			}
		}
		else {
			let startPage = "about:blank";
			if (gPreferenceManager.get("browser.startup.page", 1, true) == 1) {
				startPage = this.SeaMonkey_getHomePageGroup();
			}
			return "arguments" in aWindow && aWindow.arguments.length && (aWindow.arguments[0] == startPage);
		}
	},

	SeaMonkey_getHomePageGroup: function()
	{
		let homePage = gPreferenceManager.get("browser.startup.homepage", "", true);
		let count = gPreferenceManager.get("browser.startup.homepage.count", 0, true);

		for (let i = 1; i < count; ++i) {
			homePage += '\n' + gPreferenceManager.get("browser.startup.homepage." + i, "", true);
		}
		return homePage;
	},
	
	// Return private browsing mode (PBM) state - If user choose to allow saving in PBM and encryption
	// is enabled, return false.
	isPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox
		if (PrivateBrowsing) {
			return PrivateBrowsing.privateBrowsingEnabled;
		}
		else {
			return false;
		}
	},

	isAutoStartPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox
		if (PrivateBrowsing) {
			return PrivateBrowsing.autoStarted;
		}
		else {
			return false;
		}
	},

	checkAutoSaveTimer: function(aOldTime)
	{
		// only act if timer already started
		if (this._autosave_timer && ((this.mPref["_autosave_time"] <= 0) || !this.mPref["_autosave_filename"])) {
			this._autosave_timer.cancel();
			this._autosave_timer = null;
			log("checkAutoSaveTimer: Autosave Session Timer stopped", "INFO");
		}
		else if ((this.mPref["_autosave_time"] > 0) && this.mPref["_autosave_filename"]) {
			if (aOldTime != this.mPref["backup_every_time"]) {
				if (this._autosave_timer)
					this._autosave_timer.cancel();
				else
					this._autosave_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				// Firefox bug 325418 causes PRECISE timers to not fire correctly when canceled and re-initialized so use SLACK instead - https://bugzilla.mozilla.org/show_bug.cgi?id=325418
				this._autosave_timer.init(gSessionManager, this.mPref["_autosave_time"] * 60000, Ci.nsITimer.TYPE_REPEATING_SLACK);
				log("checkAutoSaveTimer: Autosave Session Timer (re-)started for " + this.mPref["_autosave_time"] + " minute(s)", "INFO");
			}
		}
	},
	
	checkBackupTimer: function(aOldTime)
	{
		log("checkBackupTimer: timer = " + this._backup_timer + ", checked = " + this.mPref["backup_every"] + ", time = " + this.mPref["backup_every_time"] + ", oldtime = " + aOldTime, "DATA");
		// only act if timer already started
		if (this._backup_timer && (!this.mPref["backup_every"] || (this.mPref["backup_every_time"] <= 0))) {
			this._backup_timer.cancel();
			this._backup_timer = null;
			log("checkBackupTimer: Backup Session Timer stopped", "INFO");
		}
		else if (this.mPref["backup_every"] && (this.mPref["backup_every_time"] > 0)) {
			if (aOldTime != this.mPref["backup_every_time"]) {
				if (this._backup_timer)
					this._backup_timer.cancel();
				else
					this._backup_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				// Firefox bug 325418 causes PRECISE timers to not fire correctly when canceled and re-initialized so use SLACK instead - https://bugzilla.mozilla.org/show_bug.cgi?id=325418
				this._backup_timer.init(gSessionManager, this.mPref["backup_every_time"] * 60000, Ci.nsITimer.TYPE_REPEATING_SLACK);
				log("checkBackupTimer: Backup Session Timer (re-)started for " + this.mPref["backup_every_time"] + " minute(s)", "INFO");
			}
		}
	},
	
/* ........ Auxiliary Functions .............. */

	getNoUndoData: function(aLoad, aMode)
	{
		return aLoad ? { tabs: (!this.mPref["save_closed_tabs"] || (this.mPref["save_closed_tabs"] == 1 && (aMode != "startup"))),
		                 windows: (!this.mPref["save_closed_windows"] || (this.mPref["save_closed_windows"] == 1 && (aMode != "startup"))) }
		             : { tabs: (this.mPref["save_closed_tabs"] < 2), windows: (this.mPref["save_closed_windows"] < 2) };
	},

	// count windows and tabs
	getCount: function(aState)
	{
		let windows = 0, tabs = 0;
		
		try {
			let state = this.JSON_decode(aState);
			state.windows.forEach(function(aWindow) {
				windows = windows + 1;
				tabs = tabs + aWindow.tabs.length;
			});
		}
		catch (ex) { logError(ex); };

		return { windows: windows, tabs: tabs };
	},
	
	getSessionState: function(aName, aWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime, aState, aMergeState)
	{
		// aState - State JSON string to use instead of the getting the current state.
		// aMergeState - State JSON string to merge with either the current state or aState.
		//
		// The passed in state is used for saving old state when shutting down in private browsing mode and when saving specific windows
		// The merge state is used to append to sessions.
		if (aState) log("getSessionState: " + (aMergeState ? "Merging" : "Returning") + " passed in state", "INFO");
		let state;
		try {
			try {
				state = aState ? aState : (aWindow ? SessionStore.getWindowState(aWindow) : SessionStore.getBrowserState());
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					state = aState ? aState : (aWindow ? SessionStore.getWindowState(aWindow) : SessionStore.getBrowserState());
				}
				else throw(ex);
			}
			
			if (aMergeState) {
				state = this.JSON_decode(state);
				aMergeState = this.JSON_decode(aMergeState);
				state.windows = state.windows.concat(aMergeState.windows);
				if (state._closedWindows && aMergeState._closedWindows) state._closedWindows = state._closedWindows.concat(aMergeState._closedWindows);
				state = this.JSON_encode(state);
			}
		}
		catch(ex) {
			// Log and rethrow errors
			logError(ex);
			throw(ex);
		}
		
		state = this.modifySessionData(state, aNoUndoData, true);
		let count = this.getCount(state);
		
		// encrypt state if encryption preference set and flag not set
		if (!aDoNotEncrypt) {
			state = this.decryptEncryptByPreference(state); 
			if (!state) return null;
		}

		let window = aWindow || this.getMostRecentWindow();
		let width = null;
		let height = null;
		if (window && (typeof(window) == "object")) {
			width = window.screen.width;
			height = window.screen.height;
		}
		aAutoSaveTime = isNaN(aAutoSaveTime) ? 0 : aAutoSaveTime;
		
		return (aName != null)?this.nameState("timestamp=" + Date.now() + "\nautosave=" + ((aAutoSave)?aWindow?("window/" + aAutoSaveTime):("session/" + aAutoSaveTime):"false") +
		                                      "\tcount=" + count.windows + "/" + count.tabs + (aGroup? ("\tgroup=" + aGroup.replace(/\t/g, " ")) : "") +
		                                      "\tscreensize=" + (this._screen_width || width) + "x" + (this._screen_height || height) + "\n" + state, aName || "") : state;
	},

	restoreSession: function(aWindow, aState, aReplaceTabs, aNoUndoData, aEntireSession, aOneWindow, aStartup, aWindowSessionValues, xDelta, yDelta, aFileName)
	{
		log("restoreSession: aWindow = " + aWindow + ", aReplaceTabs = " + aReplaceTabs + ", aNoUndoData = " + (aNoUndoData ? JSON.stringify(aNoUndoData) : "undefined") + 
		         ", aEntireSession = " + aEntireSession + ", aOneWindow = " + aOneWindow + ", aStartup = " + aStartup + 
				 ", aWindowSessionValues = " + (aWindowSessionValues ? ("\"" + aWindowSessionValues.split("\n").join(", ") + "\"") : "undefined") + ", xDelta = " + xDelta + 
				 ", yDelta = " + yDelta + ", aFileName = " + aFileName, "DATA");
		// decrypt state if encrypted
		aState = this.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = this.openWindow(gPreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				gSessionManager.restoreSession(this, aState, aReplaceTabs, aNoUndoData, null, null, null, aWindowSessionValues, xDelta, yDelta, aFileName);
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		aState = this.modifySessionData(aState, aNoUndoData, false, aWindow, aEntireSession, aOneWindow, aStartup, (aFileName == this._crash_session_filename),
		                                this._restoring_backup_session, xDelta, yDelta, aWindow.screen);  

		if (aEntireSession)
		{
			try {
				SessionStore.setBrowserState(aState);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					SessionStore.setBrowserState(aState);
				}
				else throw(ex);
			}
		}
		else
		{
			try {
				// if not overwriting tabs on startup (i.e. clicked shortcut to start Firefox) and not preserving app tabs, remove them
				if (aStartup && !aReplaceTabs && gecko2plus && !this.mPref["preserve_app_tabs"]) {
					let i = 0;
					while (i < aWindow.gBrowser.mTabs.length) {
						if (aWindow.gBrowser.mTabs[i].pinned)
							aWindow.gBrowser.removeTab(aWindow.gBrowser.mTabs[i]);
						else
							i++;
					}
				}
			
				SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
				}
				else throw(ex);
			}
		}
		
		// Store autosave values into window value and also into window variables
		if (!aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename) {
			// Backup _sm_window_session_values first in case we want to restore window sessions from non-window session.
			// For example, in the case of loading the backup session at startup.
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject._backup_window_sesion_data = SessionStore.getWindowValue(aWindow,"_sm_window_session_values");
			log("restoreSession: Removed window session name from window: " + aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject._backup_window_sesion_data, "DATA");
			this.getAutoSaveValues(aWindowSessionValues, aWindow);
		}
		log("restoreSession: restore done, window_name  = " + aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename, "DATA");
		// On Startup, if restoring backup session or last autosave session tell Session Manager Component the number of windows being restored.  
		// Subtract one since the current window counts as #1.  For crashed session use actual count.
		if (aStartup && (aFileName == this._crash_session_filename || this._restoring_backup_session || this._restoring_autosave_backup_session)) {
			this._countWindows = true;
			// if recovering from crash, sessionstore:windows-restored notification is ignored so sessionmanager window count will already be one so don't subract anything.
			if (this._restoring_backup_session || this._restoring_autosave_backup_session)
				_number_of_windows -= 1;
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:windows-restored", _number_of_windows);
		}

		// Save session manager window value for aWindow since it will be overwritten on load.  Other windows opened will have the value set correctly.
		if (aWindow.__SSi && aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject) {
			aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__SessionManagerWindowId = aWindow.__SSi;
			SessionStore.setWindowValue(aWindow, "__SessionManagerWindowId", aWindow.__SSi);
		}
		
		return true;
	},

	nameState: function(aState, aName)
	{
		if (!/^\[SessionManager v2\]/m.test(aState))
		{
			return "[SessionManager v2]\nname=" + aName.replace(/\t/g, " ") + "\n" + aState;
		}
		return aState.replace(/^(\[SessionManager v2\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName.replace(/\t/g, " "); });
	},

	// Parameters are current window to process and existing tab group data
	// The function will update the group data to make sure it is unique
	fixTabGroups: function(aWinData, tab_group_data) {
		let no_group_data = !tab_group_data;
		let current_tab_groups, current_tab_group;

		// Get tabview-groups data
		if (aWinData.extData && aWinData.extData["tabview-groups"]) {
			current_tab_groups = this.JSON_decode(aWinData.extData["tabview-groups"], true);
		}
		if (!current_tab_groups || current_tab_groups._JSON_decode_failed )
			return;

		if (aWinData.extData && aWinData.extData["tabview-group"]) {
			current_tab_group = this.JSON_decode(aWinData.extData["tabview-group"], true);
		}
		if (!current_tab_group || current_tab_group._JSON_decode_failed )
			return;

		// If no existing group data, store current data otherwise merge the data
		if (!tab_group_data)
			tab_group_data = { tabview_groups : current_tab_group, tabview_group : current_tab_group };
		else {
			// Update nextID
			if (current_tab_groups.nextID > tab_group_data.tabview_groups.nextID)
				tab_group_data.tabview_groups.nextID = current_tab_groups.nextID;
			// Change group id numbers if need be
			for (var id in current_tab_group) {
				// if id already exists, choose a different id
				if (tab_group_data.tabview_group[id]) {
					let new_id = tab_group_data.tabview_groups.nextID++;
					tab_group_data.tabview_group[new_id] = current_tab_group[id];
					tab_group_data.tabview_group[new_id].id = new_id;
					
					// update tabview-tab data
					aWinData.tabs.forEach(function(aTabData) {
						if (aTabData.extData && aTabData.extData["tabview-tab"]) {
							let tabview_data = gSessionManager.JSON_decode(aTabData.extData["tabview-tab"], true);
							if (tabview_data && !tabview_data._JSON_decode_failed) {
								if (tabview_data.groupID == id) {
									// update id and save
									tabview_data.groupID = new_id;
									aTabData.extData["tabview-tab"] = gSessionManager.JSON_encode(tabview_data);
								}
							}
						}
					});
				}
				else {
					tab_group_data.tabview_group[id] = current_tab_group[id];
				}
			}
		}
	},
	
	// aBrowserWindow = existing browser window
	makeOneWindow: function(aBrowserWindow,aState)
	{
		let tab_group_data;
	
		// Grab existing tab group info from browser window
		let currentWindowState = SessionStore.getWindowState(aBrowserWindow);
		let tabview_groups = SessionStore.getWindowValue(aBrowserWindow, "tabview-groups");
		let tabview_group = SessionStore.getWindowValue(aBrowserWindow, "tabview-group");
		if (tabview_groups && tabview_group) {
			tabview_groups = this.JSON_decode(tabview_groups);
			tabview_group = this.JSON_decode(tabview_group);
			if (tabview_groups && !tabview_groups._JSON_decode_failed && tabview_group && !tabview_group._JSON_decode_failed)
				tab_group_data = { tabview_groups: tabview_groups, tabview_group: tabview_group };
		}
	
		if (aState.windows.length > 1)
		{
			// take off first window
			let firstWindow = aState.windows.shift();
			this.fixTabGroups(firstWindow, tab_group_data);
			// make sure toolbars are not hidden on the window
			delete firstWindow.hidden;
			// Move tabs to first window
			aState.windows.forEach(function(aWindow) {
				gSessionManager.fixTabGroups(aWindow, tab_group_data);
				while (aWindow.tabs.length > 0)
				{
					this.tabs.push(aWindow.tabs.shift());
				}
			}, firstWindow);
			
			// Update firstWindow with new group info
			if (tab_group_data) {
				if (!firstWindow.extData) 
					firstWindow.extData = {};
				firstWindow.extData["tabview-groups"] = this.JSON_encode(tab_group_data.tabview_groups);
				firstWindow.extData["tabview-group"] = this.JSON_encode(tab_group_data.tabview_group);
			}
			
			// Remove all but first window
			aState.windows = [];
			aState.windows[0] = firstWindow;
		}
		else if (aState.windows.length == 1) {
			this.fixTabGroups(aState.windows[0], tab_group_data);
			// Update Window with new group info
			if (tab_group_data) {
				if (!aState.windows[0].extData) 
					aState.windows[0].extData = {};
				aState.windows[0].extData["tabview-groups"] = this.JSON_encode(tab_group_data.tabview_groups);
				aState.windows[0].extData["tabview-group"] = this.JSON_encode(tab_group_data.tabview_group);
			}
		}
	},
	
	// returns an array of windows containing app tabs for that window or null (if no app tabs in window)
	// If aCrashRecover is true, read app tabs from crash backup since we didn't restore crashed session
	gatherAppTabs: function(aCrashRecover) 
	{
		let state = null;
	
		// only check if Firefox 4 or higher and user cares
		if (gecko2plus && this.mPref["preserve_app_tabs"]) {
			
			try {
				if (aCrashRecover) {
					log("recover app tabs from crash file", "INFO");
					let file = this.getSessionDir(this._crash_backup_session_file);
					state = this.readSessionFile(file).split("\n")[4];
					state = this.JSON_decode(this.decrypt(state));
				}
				else
					state = this.JSON_decode(SessionStore.getBrowserState());
			}
			catch (ex) { 
				logError(ex);
				return null;
			};
			
			if (state) {
				// filter out all tabs that aren't pinned
				state = state.windows.map(function(aWindow) {
					aWindow.tabs = aWindow.tabs.filter(function(aTab) {
						return aTab.pinned;
					});
					// fix selected tab index
					if (aWindow.selected > aWindow.tabs.length)
						aWindow.selected = aWindow.tabs.length;
						
					return (aWindow.tabs.length > 0) ? aWindow : null;
				});
			}
		}
		
		return state;
	},

	// Note, there are two cases where loading a session can result in merging of multiple window.  One is when the aOneWindow
	// value is set, and the other is when aReplaceTabs is true, but aEntireSession is false.  The later can only occur at browser startup
	// and only when the user starts Firefox with a command line argument or when browser updates.  Neither of those cases will have a group
	// so we only need to fix groups when merging into oneWindow.
	modifySessionData: function(aState, aNoUndoData, aSaving, aBrowserWindow, aReplacingWindow, aSingleWindow, aStartup, aCrashFile, aPreviousSession, xDelta, yDelta, aScreen)
	{
		if (!xDelta) xDelta = 1;
		if (!yDelta) yDelta = 1;
	
		aState = this.JSON_decode(aState);
		
		// set _firsttabs to true on startup to prevent closed tabs list from clearing when not overwriting tabs.
		if (aStartup && aReplacingWindow) aState._firstTabs = true;
		
		// Fix window data based on settings
		let fixWindow = function(aWindow) {
			// Strip out cookies if user doesn't want to save them
			if (aSaving && !gSessionManager.mPref["save_cookies"]) delete aWindow.cookies;

			// remove closed tabs			
			if (aNoUndoData && aNoUndoData.tabs) aWindow._closedTabs = [];
			
			// adjust window position and height if screen dimensions don't match saved screen dimensions
			aWindow.width = aWindow.width * xDelta;
			aWindow.height = aWindow.height * yDelta;
			aWindow.screenX = aWindow.screenX * xDelta;
			aWindow.screenY = aWindow.screenY * yDelta;
			
			// Make sure window doesn't load offscreen.  Only do this if there is one screen, otherwise it causes windows to move to first screen.
			if (aScreen && (SCREEN_MANAGER.numberOfScreens == 1)) {
				if (aWindow.screenX > aScreen.width) 
					aWindow.screenX = aScreen.width - aWindow.width;
				else if ((aWindow.screenX + aWindow.width) < 0)
					aWindow.screenX = 0;
				if (aWindow.screenY > aScreen.height) 
					aWindow.screenY = aScreen.height - aWindow.height;
				else if ((aWindow.screenY + aWindow.height) < 0)
					aWindow.screenY = 0;
			}
		};
		
		// If loading, replacing windows and not previous session, add app tabs to loading state (if needed)
		if (!aSaving && aReplacingWindow && !aPreviousSession) {
			let appTabState = this.gatherAppTabs(aStartup && aCrashFile);
			//log("Gathered App Tabs = " + this.JSON_encode(appTabState), "EXTRA");
			if (appTabState) {
				appTabState.forEach(function(aWindow, aIndex) {
					// if there are any app tabs copy them to the loading state
					if (aWindow) {
						if (aState.windows.length > aIndex) {
							aState.windows[aIndex].tabs = aState.windows[aIndex].tabs.concat(aWindow.tabs);
						}
						else  {
							aState.windows.push(aWindow);
						}
					}
				});
				//log("Merged load session = " + this.JSON_encode(aState), "EXTRA");
			}
		}

		// If loading and making one window do that, otherwise process opened window
		if (!aSaving && !aReplacingWindow && aSingleWindow) {
			this.makeOneWindow(aBrowserWindow,aState);
			fixWindow(aState.windows[0]);
		}
		else
			aState.windows.forEach(fixWindow, this);
		
		// process closed windows (for sessions only)
		if (aState._closedWindows) {
			if (this.mUseSSClosedWindowList && aNoUndoData && aNoUndoData.windows) {
				aState._closedWindows = [];
			}
			else  {
				aState._closedWindows.forEach(fixWindow, this);
			}
		}

		// if only one window, don't allow toolbars to be hidden
		if (aReplacingWindow && (aState.windows.length == 1) && aState.windows[0].hidden) {
			delete aState.windows[0].hidden;
			// Since nothing is hidden in the first window, it cannot be a popup (see Firefox bug 519099)
			delete aState.windows[0].isPopup;
		}
		
		// save number of windows
		_number_of_windows = aState.windows.length;
		
		return this.JSON_encode(aState);
	},

	getFormattedName: function(aTitle, aDate, aFormat)
	{
		function cut(aString, aLength)
		{
			return aString.replace(new RegExp("^(.{" + (aLength - 3) + "}).{4,}$"), "$1...");
		}
		function toISO8601(aDate, format)
		{
			if (format) {
				return aDate.toLocaleFormat(format);
			}
			else {
				return [aDate.getFullYear(), pad2(aDate.getMonth() + 1), pad2(aDate.getDate())].join("-");
			}
		}
		function pad2(a) { return (a < 10)?"0" + a:a; }
		
		return (aFormat || this.mPref["name_format"]).split("%%").map(function(aPiece) {
			return aPiece.replace(/%(\d*)([tdm])(\"(.*)\")?/g, function($0, $1, $2, $3, $4) {
				$0 = ($2 == "t")?aTitle:($2 == "d")?toISO8601(aDate, $4):pad2(aDate.getHours()) + ":" + pad2(aDate.getMinutes());
				return ($1)?cut($0, Math.max(parseInt($1), 3)):$0;
			});
		}).join("%");
	},

	makeFileName: function(aString)
	{
		// Make sure we don't replace spaces with _ in filename since tabs become spaces
		aString = aString.replace(/\t/g, " ");
		
		// Reserved File names under Windows so add a "_" to name if one of them is used
		if (INVALID_FILENAMES.indexOf(aString) != -1) aString += "_";
		
		// Don't allow illegal characters for Operating Systems:
		// NTFS - <>:"/\|*? or ASCII chars from 00 to 1F
		// FAT - ^
		// OS 9, OS X and Linux - :
		return aString.replace(/[<>:"\/\\|*?^\x00-\x1F]/g, "_").substr(0, 64) + SESSION_EXT;
//		return aString.replace(/[^\w ',;!()@&+=~\x80-\xFE-]/g, "_").substr(0, 64) + SESSION_EXT;
	},
	
	getMostRecentWindow: function(aType, aOpenWindowFlag)
	{
		let window = null;
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			window = WINDOW_MEDIATOR_SERVICE.getMostRecentWindow(aType ? aType : null);
		}
		else {
			log("Sanity Check Failure: getMostRecentWindow() called from background thread - this would have caused a crash.", "EXTRA");
		}
		if (aOpenWindowFlag && !window) {
			window = this.openWindow(gPreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
		}
		return window;
	},
	
	// This will return the window with the matching SessionStore __SSi value if it exists
	getWindowBySSI: function(window__SSi) 
	{
		let windows = this.getBrowserWindows();
		for (var i=0; i<windows.length; i++)
		{
			if (windows[i].__SSi == window__SSi)
				return windows[i];
		}
		return null;
	},
	
	getBrowserWindows: function()
	{
		let windowsEnum = WINDOW_MEDIATOR_SERVICE.getEnumerator("navigator:browser");
		let windows = [];
		
		while (windowsEnum.hasMoreElements())
		{
			windows.push(windowsEnum.getNext());
		}
		
		return windows;
	},
	
	updateAutoSaveSessions: function(aOldFileName, aNewFileName, aNewName, aNewGroup) 
	{
		let updateTitlebar = false;
		
		// auto-save session
		if (this.mPref["_autosave_filename"] == aOldFileName) 
		{
			log("updateAutoSaveSessions: autosave change: aOldFileName = " + aOldFileName + ", aNewFileName = " + aNewFileName + ", aNewName = " + aNewName + ", aNewGroup = " + aNewGroup, "DATA");
			// rename or delete?
			if (aNewFileName) {
				gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aNewFileName, aNewName, this.mPref["_autosave_group"], this.mPref["_autosave_time"]));
				updateTitlebar = true;
			}
			else if (aNewName) {
				gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aOldFileName, aNewName, this.mPref["_autosave_group"], this.mPref["_autosave_time"]));
			}
			else if (aNewGroup) {
				gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aOldFileName, this.mPref["_autosave_name"], aNewGroup, this.mPref["_autosave_time"]));
			}
			else {
				gPreferenceManager.set("_autosave_values","");
				updateTitlebar = true;
			}
		}
		
		// window sessions
		this.getBrowserWindows().forEach(function(aWindow) {
			if (aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject && aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename && (aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename == aOldFileName)) { 
				log("updateAutoSaveSessions: window change: aOldFileName = " + aOldFileName + ", aNewFileName = " + aNewFileName + ", aNewGroup = " + aNewGroup, "DATA");
				if (aNewFileName) {
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename = aNewFileName;
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_name = aNewName;
					delete this.mActiveWindowSessions[aOldFileName];
					this.mActiveWindowSessions[aNewFileName] = true;
					updateTitlebar = true;
				}
				else if (aNewGroup) {
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_group = aNewGroup;
				}
				else
				{
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_filename = null;
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_name = null;
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_group = null;
					aWindow.com.morac.SessionManagerAddon.gSessionManagerWindowObject.__window_session_time = 0;
					delete this.mActiveWindowSessions[aOldFileName];
					updateTitlebar = true;
				}
			}
		}, this);
		
		// Update titlebars
		if (updateTitlebar) OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:updatetitlebar", null);
	},

	doResumeCurrent: function()
	{
		return (gPreferenceManager.get("browser.startup.page", 1, true) == 3)?true:false;
	},

	isCleanBrowser: function(aBrowser)
	{
		return aBrowser.sessionHistory.count < 2 && aBrowser.currentURI.spec == "about:blank";
	},

	setDisabled: function(aObj, aValue)
	{
		if (!aObj) return;
		if (aValue)
		{
			aObj.setAttribute("disabled", "true");
		}
		else
		{
			aObj.removeAttribute("disabled");
		}
	},

	_string: function(aName)
	{
		return SM_BUNDLE.GetStringFromName(aName);
	},

	// Decode JSON string to javascript object - use JSON if built-in.
	JSON_decode: function(aStr, noError) {
		let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
		try {
			// JSON can't parse when string is wrapped in parenthesis, it shouldn't but older versions of Firefox wrapped
			// JSON data in parenthesis, so simply removed them if they are there.
			if (aStr.charAt(0) == '(')
				aStr = aStr.slice(1, -1);
		
			// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so any sessions saved
			// with that version or earlier will fail here.  I used to try to eval in sandbox these, but that's not safe
			// so try to fix the actual session if possible.
			try {
				jsObject = JSON.parse(aStr);
			}
			catch (ex) {
				// All the following will attempt to convert an invalid JSON file into a valid one.  This is based off of old session
				// files that I had lying aroudn that had been saved years ago.  This fixed all of them, but it's possible there's
				// a session out there that won't get corrected.  The good news is that this is sessions that are from over 2 years ago
				// so hopefully it's not a big issue.  Also the user can always go back to an older version of Session Manager and load 
				// and resave the session.  If a session can be fixed, it will automatically be resaved so this should
				// only happen once per "bad" session.  Note Firefox itself still does an eval if it can't read a session, but apparently
				// addons aren't allowed to do so.
				
				// Needed for sessions saved under old versions of Firefox to prevent a JSON failure since Firefox bug 387859 was fixed in Firefox 4.
				if (/[\u2028\u2029]/.test(aStr)) {
					aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {return "\\u" + $0.charCodeAt(0).toString(16)});
				}

				// Try to wrap all JSON properties with quotes.  Replace wrapped single quotes with double quotes.  Don't wrap single quotes
				// inside of data.  
				aStr = aStr.replace(/(([^=#"']|^){|,\s[{']|([0-9\]}"]|null|true|false),\s)'?([^'":{}\[\]//]+)'?/gi, function(str, p1, p2, p3, p4, offset, s) { 
					return (p1 + '"' + p4.substr(0, p4.length - ((p4[p4.length-1] == "'") ? 1 : 0)) + '"').replace("'\"",'"',"g");
				});
				// Fix any escaped single quotes as those will cause a problem.
				aStr = aStr.replace(/([^\\])'(:)/g,'$1"$2').replace(/(([^=#"']|^){|,\s[{']|([0-9\]}"]|null|true|false),\s)'/g,'$1"').replace("\\'","'","g");
				// Try to remove any escaped unicode characters as those also cause problems
				aStr = aStr.replace(/\\x([0-9|A-F]{2})/g, function (str, p1) {return String.fromCharCode(parseInt("0x" + p1)).toString(16)});
				// Hopefully at this point we have valid JSON, here goes nothing. :)
				jsObject = JSON.parse(aStr);
				if (jsObject)
					jsObject._fixed_bad_JSON_data = true;
			}
		}
		catch(ex) {
			jsObject._JSON_decode_error = ex;
			if (!noError) this.sessionError(ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function(aObj) {
		let jsString = null;
		try {
			jsString = JSON.stringify(aObj);
			// Needed in Firefox 3.6 to prevent JSON failure since Firefox bug 387859 was fixed in Firefox 4.
			if (!gecko2plus && /[\u2028\u2029]/.test(jsString)) {
				jsString = jsString.replace(/[\u2028\u2029]/g, function($0) {return "\\u" + $0.charCodeAt(0).toString(16)});
			}
		}
		catch(ex) {
			this.sessionError(ex);
		}
		return jsString;
	},
};
