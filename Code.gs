/**
 * Tracker — Dashboard Edition (shift tabs + master)
 * =====================================================================
 * THE SPREADSHEET
 *   One tab per SHIFT (OverNight / Night / Morning — see SHIFT_SHEETS) that holds
 *   the trainees: Name | Join Date | National ID | PC Training | Training Site | ...
 *   Pass / P / Failed / Dropped out are written in each shift tab's "State" column,
 *   the chosen trainers in its "Trainer P1/P2/P3" columns.
 *   ONE app sheet called "master": every sign-up (Name, Join Date, National ID, Phone,
 *   Gmail, Shift, Location) plus the stage, the check-ins and the comments / ratings
 *   typed in the dashboard (the "dashboard" column; they are NOT written in the shift
 *   tabs). A hidden "users" sheet holds the logins. There is no Entries / Attend sheet.
 *
 * SIGN UP (the "Login" form): a row in "master" + the trainee is added to the tab of
 *   their shift (Name, Join Date = today, National ID, Training Site = location), kept in
 *   blocks per JOIN DATE separated by a black row.
 * SIGN IN (National ID only): check-in for today. Day 1 = the Join Date.
 * ATTENDANCE (dashboard tab): computed from the check-ins (T1 / T2 / T3 / TP, 0 for missed
 *   days, or a value you click in). Two "0" in a row before T3 => red row + "Dropped out"
 *   in the State column.
 *
 * SETUP
 *   1. Open the spreadsheet > Extensions > Apps Script, paste this file as Code.gs and
 *      Index.html as "Index".
 *   2. Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 *   3. Check SHIFT_SHEETS below matches your tab names.
 *   4. (optional) DATA_SPREADSHEET_ID: id of the spreadsheet that holds the "data base"
 *      and "quality" sheets, if they are NOT in this spreadsheet.
 */

const SHEET_NAME = 'master'; // sign-ups + stage + check-ins: the ONE app sheet (there is no "Entries" any more)
const PROP_KEY = 'SPREADSHEET_ID';
const USERS_SHEET_NAME = 'users';
const ADMIN_TOKENS_KEY = 'ADMIN_TOKENS';

// ---- new layout -----------------------------------------------------
// shift (as chosen in the sign-up form) -> tab name in the spreadsheet
// (each shift can have several possible tab names; the first one that exists is used,
//  and the FIRST name is the one used when the tab has to be created)
const SHIFT_SHEETS = {
  ON: ['OverNight', 'Over_Night', 'Over Night', 'Dorm_Night', 'Dom_Night'],
  N: ['Night'],
  M: ['Morning']
};
const REGISTER_SHIFTS = ['ON', 'N', 'M'];
const REGISTER_LOCATIONS = ['NC', 'SF'];
const DATA_SPREADSHEET_ID = ''; // optional, see SETUP
const SEP_PREFIX = '▶ ';        // marks the black separator rows the app creates

// Two "0" in a row BEFORE the trainee reaches T3 => red row + "Dropped out".
const DROPOUT_ABSENT_DAYS = 2;
const FEEDBACK_VALUES = ['Pass', 'P', 'Failed', 'Dropped out']; // written into the "State" column of the shift tab

// "master" column layout (1-based):
// 1 Name | 2 Join Date | 3 National ID | 4 Phone | 5 Gmail | 6 Shift | 7 Location |
// 8 stage | 9 startedAt | 10 updatedAt | 11 attendance (JSON: day -> value) |
// 12 dashboard (JSON: the comments and ratings typed in the dashboard)
const HEADERS = ['Name', 'Join Date', 'National ID', 'Phone', 'Gmail', 'Shift', 'Location', 'stage', 'startedAt', 'updatedAt', 'attendance', 'dashboard'];
const COL = { name:1, joinDate:2, nationalId:3, phone:4, gmail:5, shift:6, location:7, stage:8, startedAt:9, updatedAt:10, attendance:11, notes:12 };

// Must stay in the same order as the frontend's STAGES array — used only
// to stop a trainee from picking a stage that comes BEFORE their current
// one (forward-only progress).
const STAGE_ORDER = [
  'p1_video','p1_vehicle','p1_motorcycle','p1_task9106','p1_task9661','p1_task3200',
  'p2_video','p2_signs','p2_dynamicobstacle','p2_debris','p2_cone','p2_barrier','p2_vegetation','p2_vapor','p2_task5747','p2_task6464','p2_task6470',
  'p3_video','p3_qaerrors','p3_mapless','p3_signals','p3_roadsign','p3_nlz','p3_task7362'
];

// Stage ids that were removed from the list. Trainees who still have one stored
// in the sheet are shown at the first stage of that phase instead of "nothing".
const LEGACY_STAGE_MAP = {
  p1_gulp: 'p1_vehicle', p1_phaseone: 'p1_vehicle',
  p2_phasetwo: 'p2_signs', p2_inanimate: 'p2_signs', p2_pedestrian: 'p2_signs', p2_personalvehicle: 'p2_signs',
  p3_autogrounding: 'p3_qaerrors', p3_emv: 'p3_qaerrors', p3_zone: 'p3_qaerrors', p3_shapeless: 'p3_qaerrors',
  // removed Mapless / ME4 phases -> last stage that is left
  mp_highwaylidar: 'p3_task7362', mp_techhighway: 'p3_task7362', mp_highway: 'p3_task7362', mp_gradesep: 'p3_task7362', mp_taskmapless: 'p3_task7362',
  me4_em4lidar: 'p3_task7362', me4_roadsign: 'p3_task7362', me4_vehiclesignals: 'p3_task7362', me4_commonmistakes: 'p3_task7362', me4_commonmistakes2: 'p3_task7362'
};
function normalizeStage_(id) {
  const v = toStr_(id);
  return LEGACY_STAGE_MAP[v] || v;
}


// ---------------------------------------------------------------------
// JSON API — lets Index.html be hosted ANYWHERE (e.g. GitHub Pages)
// ---------------------------------------------------------------------
// Only the functions listed here can be called from outside. Admin functions
// still need the secret admin token (last argument).
const API_FUNCTIONS = {
  getTheme: getTheme, setTheme: setTheme,
  checkIn: checkIn, lookupPerson: lookupPerson, getAttendanceMonth: getAttendanceMonth,
  advanceStage: advanceStage, registerTrainee: registerTrainee, getMyStages: getMyStages, setMyStage: setMyStage,
  adminLogin: adminLogin, isAdminUnlocked: isAdminUnlocked, lockAdmin: lockAdmin,
  adminSyncAllAttendance: adminSyncAllAttendance, adminSetupDailyTrigger: adminSetupDailyTrigger,
  adminArrangeShiftSheets: adminArrangeShiftSheets,
  adminAddPerson: adminAddPerson, adminGetAllPeople: adminGetAllPeople, adminDeletePerson: adminDeletePerson,
  adminGetTeams: adminGetTeams, adminSaveComment: adminSaveComment,
  adminGetAttendance: adminGetAttendance, adminSetAttendance: adminSetAttendance,
  getDashboardData: getDashboardData, getQualityData: getQualityData
};

function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const name = toStr_(body.fn);
    if (!Object.prototype.hasOwnProperty.call(API_FUNCTIONS, name)) throw new Error('Unknown function.');
    const args = Array.isArray(body.args) ? body.args : [];
    out = { ok: true, result: API_FUNCTIONS[name].apply(null, args) };
  } catch (err) {
    out = { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------
// Spreadsheet / sheet plumbing
// ---------------------------------------------------------------------
function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(PROP_KEY);
  if (savedId) {
    try { return SpreadsheetApp.openById(savedId); } catch (e) { /* fall through */ }
  }
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) ss = SpreadsheetApp.create('Tracker Data');
  props.setProperty(PROP_KEY, ss.getId());
  return ss;
}


/** The spreadsheet that holds "data base" and "quality" (see DATA_SPREADSHEET_ID). */
function getDataSpreadsheet_() {
  if (DATA_SPREADSHEET_ID) return SpreadsheetApp.openById(DATA_SPREADSHEET_ID);
  return getSpreadsheet_();
}

/** The "master" sheet: one row per trainee (sign-up data + stage + check-ins). */
function getSheet_() {
  const ss = getSpreadsheet_();
  let sheet = findSheetByKey_(ss, SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.getRange(2, COL.nationalId, Math.max(sheet.getMaxRows() - 1, 1), 2).setNumberFormat('@'); // National ID + Phone stay text
    sheet.getRange(2, COL.joinDate, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('M/d');
  } else {
    const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    if (existing.length < HEADERS.length) { // an older master (7 columns) gets the app columns added
      sheet.getRange(1, existing.length + 1, 1, HEADERS.length - existing.length)
        .setValues([HEADERS.slice(existing.length)]);
    }
  }
  return sheet;
}

function dayKey_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd'); }
function dayLabel_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone() || 'GMT', 'M/d'); }
function addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function daysBetween_(from, to) { return Math.round((startOfDay_(to) - startOfDay_(from)) / 86400000); }

/** Join Date cell -> Date. Accepts a real date, "10/26" (month/day) or "10/26/2026". */
function parseJoinDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return startOfDay_(v);
  const t = toStr_(v).trim();
  if (!t) return null;
  const m = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/.exec(t);
  if (m) {
    let y = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
    if (y < 100) y += 2000;
    const d = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const d2 = new Date(t);
  return isNaN(d2.getTime()) ? null : startOfDay_(d2);
}

// Header names (case / spaces / symbols ignored) used to find columns in the
// shift tabs and in "master". Columns can be in ANY order.
const BATCH_COLUMN_ALIASES = {
  nationalId: ['nationalid', 'id', 'nid', 'nationalidnumber'],
  name: ['name', 'fullname', 'traineename', 'labelername'],
  joinDate: ['joindate', 'joiningdate', 'startdate'],
  pc: ['pctraining', 'pc', 'pcno', 'pcname', 'pcnumber', 'pcid'],
  site: ['trainingsite', 'site', 'location'],
  flash: ['yubikey', 'yubikeyemail', 'flash', 'yubikeyid', 'email'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber'],
  gmail: ['gmail', 'email'],
  shift: ['shift'],
  comment: ['comment', 'comments', 'note', 'notes'],
  rating: ['rating', 'rate', 'stars'],
  feedback: ['state', 'feedback', 'result']   // the "State" column of the shift tab
};
// Trainer columns (dropdowns with the trainers' names): "Trainer P1" / "P2" / "P3".
[1, 2, 3].forEach(n => {
  BATCH_COLUMN_ALIASES['trainer' + n] = ['trainerp' + n, 'trainarp' + n, 'trainer' + n, 'trainar' + n, 'p' + n + 'trainer'];
});
// Per-day comment / rating: "Comment Day 1..4" and "Rating Day 1..4".
[1, 2, 3, 4].forEach(n => {
  BATCH_COLUMN_ALIASES['comment' + n] = ['commentday' + n, 'comment' + n, 'day' + n + 'comment', 'commentd' + n];
  BATCH_COLUMN_ALIASES['rating' + n] = ['ratingday' + n, 'rating' + n, 'day' + n + 'rating', 'ratingd' + n];
});


function toStr_(v) { return (v === null || v === undefined) ? '' : String(v); }

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd');
}

function dateKey_(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return Utilities.formatDate(dt, Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd');
}

function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function parseAttendance_(raw) {
  try {
    const obj = JSON.parse(toStr_(raw) || '{}');
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}

function calcDayNumber_(startedAtIso) {
  if (!startedAtIso) return null;
  const start = new Date(startedAtIso);
  if (isNaN(start.getTime())) return null;
  const s = startOfDay_(start);
  const n = startOfDay_(new Date());
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((n - s) / msPerDay) + 1;
}

function findRow_(sheet, nationalId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const data = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  // Trim BOTH sides before comparing — guards against stray leading/trailing
  // whitespace on either the stored cell value or the typed-in ID (common
  // with rows added before text-trimming was enforced everywhere).
  const target = toStr_(nationalId).trim();
  for (let i = 0; i < data.length; i++) {
    if (toStr_(data[i][COL.nationalId - 1]).trim() === target) {
      return { rowNum: i + 2, row: data[i] };
    }
  }
  return null;
}

/** "ME293329@meti.ai" and "me293329" both become "me293329". */
function yubikeyKey_(v) { return toStr_(v).trim().toLowerCase().split('@')[0]; }

/** 1 -> A, 27 -> AA ... */
function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function normHeader_(v) { return toStr_(v).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function sheetKey_(name) { return toStr_(name).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** Maps nationalId/name/pc/flash/comment -> 0-based column index (or -1). */
function resolveBatchColumns_(headerRow) {
  const norm = headerRow.map(normHeader_);
  const map = {};
  Object.keys(BATCH_COLUMN_ALIASES).forEach(key => {
    map[key] = -1;
    for (let i = 0; i < BATCH_COLUMN_ALIASES[key].length && map[key] === -1; i++) {
      map[key] = norm.indexOf(BATCH_COLUMN_ALIASES[key][i]);
    }
  });
  return map;
}

/** Colors the WHOLE row red whenever its Feedback cell is "Dropped out" or "Failed".
 *  Used on every shift tab (on its State column).
 *  Replaces only its own rule, other conditional formats are kept. */
function ensureDropoutRowRule_(sheet, feedbackCol1) {
  if (!feedbackCol1) return;
  const cell = '$' + colLetter_(feedbackCol1) + '2';
  const formula = '=OR(' + cell + '="Dropped out",' + cell + '="Failed")';
  const lastCol = Math.max(sheet.getLastColumn(), feedbackCol1);
  const numRows = Math.max(sheet.getMaxRows() - 1, 1);
  const range = sheet.getRange(2, 1, numRows, lastCol);
  const isOurs = r => {
    const bc = r.getBooleanCondition();
    if (!bc) return false;
    const v = bc.getCriteriaValues();
    return !!(v && v.length && /^=(\$[A-Z]+2="Dropped out"|OR\(\$[A-Z]+2="Dropped out",\$[A-Z]+2="Failed"\))$/.test(toStr_(v[0])));
  };
  const kept = sheet.getConditionalFormatRules().filter(r => !isOurs(r));
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(formula)
    .setBackground('#e06666')
    .setFontColor('#ffffff')
    .setBold(true)
    .setRanges([range])
    .build();
  sheet.setConditionalFormatRules([rule].concat(kept));
}

/** True if the day values contain DROPOUT_ABSENT_DAYS "0" in a row BEFORE the
 *  trainee reaches T3 (zeros after T3 are not counted). */
function hasConsecutiveAbsence_(values) {
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    const v = toStr_(values[i]);
    if (v === 'T3') break; // absences AFTER T3 are ignored: that row stays as it is
    run = (v === '0') ? run + 1 : 0;
    if (run >= DROPOUT_ABSENT_DAYS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// SHIFT TABS (Dorm_Night / Night / Morning) — read the trainees from them
// ---------------------------------------------------------------------
function findSheetByKey_(ss, name) {
  const key = sheetKey_(name);
  return ss.getSheets().filter(sh => sheetKey_(sh.getName()) === key)[0] || null;
}

/** The tab of a shift: the first name in SHIFT_SHEETS that exists. For the overnight
 *  shift any tab whose name starts with "over" is accepted too. */
function findShiftSheetFor_(ss, shift) {
  const names = SHIFT_SHEETS[shift] || [];
  for (let i = 0; i < names.length; i++) {
    const sh = findSheetByKey_(ss, names[i]);
    if (sh) return sh;
  }
  if (shift === 'ON') {
    return ss.getSheets().filter(sh => /^over/.test(sheetKey_(sh.getName())))[0] || null;
  }
  return null;
}

/** [{ shift: 'ON', sheet }] for every shift tab that exists. */
function getShiftSheets_() {
  const ss = getSpreadsheet_();
  const out = [];
  Object.keys(SHIFT_SHEETS).forEach(shift => {
    const sh = findShiftSheetFor_(ss, shift);
    if (sh) out.push({ shift: shift, sheet: sh });
  });
  return out;
}

function isShiftSheetName_(name) {
  const k = sheetKey_(name);
  return getShiftSheets_().some(item => sheetKey_(item.sheet.getName()) === k);
}

/** Finds the header row (it must contain "Name" and "National ID", somewhere in
 *  the first 12 rows) and maps every field to a 0-based column index. */
function getSheetLayout_(sh) {
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return null;
  const scan = Math.min(lastRow, 12);
  const top = sh.getRange(1, 1, scan, lastCol).getValues();
  for (let r = 0; r < scan; r++) {
    const cols = resolveBatchColumns_(top[r]);
    if (cols.nationalId !== -1 && cols.name !== -1) return { headerRow: r + 1, cols: cols, lastCol: lastCol };
  }
  return null;
}

/** "PHASE1" / "Phase 2" / "phase 3" -> "Phase 1" / "Phase 2" / "Phase 3". */
function normalizePhase_(t) {
  const m = /phase\s*(\d+)/i.exec(toStr_(t));
  return m ? 'Phase ' + m[1] : toStr_(t).trim();
}

/** The STAGE columns of a shift tab = its checkbox columns. They are found from
 *  the data validation of a trainee row; the phase comes from the group header
 *  right above the header row (PHASE1 / Phase 2 / ...), the name from the header. */
function getStageColumns_(sh, layout, sampleRow) {
  const hr = layout.headerRow, lastCol = layout.lastCol;
  const dvs = sh.getRange(sampleRow, 1, 1, lastCol).getDataValidations()[0];
  const heads = sh.getRange(hr, 1, 1, lastCol).getValues()[0];
  const groups = hr > 1 ? sh.getRange(hr - 1, 1, 1, lastCol).getValues()[0] : [];
  const out = [];
  let phase = '';
  for (let j = 0; j < lastCol; j++) {
    const g = toStr_(groups[j]).trim();
    if (g) phase = normalizePhase_(g);
    const dv = dvs[j];
    if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) {
      out.push({
        idx: j,
        label: toStr_(heads[j]).replace(/\s+/g, ' ').trim() || ((phase || 'Stage') + ' #' + (out.length + 1)),
        phase: phase || 'Stages'
      });
    }
  }
  return out;
}

/** Links for the stage names found in the sheet. The first rule that matches the
 *  header text wins. Add your own lines here. */
const STAGE_LINK_RULES = [
  { re: /motorcycle/i, link: 'https://sites.google.com/meti.ai/training-material/home/unified-taxonomy/personal-vehicle/motorcycle' },
  { re: /vehicles?\s*material|vehicles?\b/i, link: 'https://sites.google.com/meti.ai/training-material/home/unified-taxonomy/vehicles?pli=1&authuser=0' },
  { re: /inanimate/i, link: 'https://sites.google.com/meti.ai/training-material/home/unified-taxonomy/inanimate-objects' },
  { re: /pedestrian/i, link: 'https://sites.google.com/meti.ai/training-material/home/unified-taxonomy/pedestrian' },
  { re: /qa/i, link: 'https://sites.google.com/meti.ai/training-material/home/welcome-to-meti/practicing/auto-qa-errors' },
  { re: /mapless/i, link: 'https://sites.google.com/meti.ai/training-material/home/queues/current-queue/sc3-full-scene-lidar' },
  { re: /nlz/i, link: 'https://sites.google.com/meti.ai/training-material/home/queues/sc3-full-scene-2-1-versioning/nlz-labeling' }
];
function stageLink_(label) {
  for (let i = 0; i < STAGE_LINK_RULES.length; i++) if (STAGE_LINK_RULES[i].re.test(label)) return STAGE_LINK_RULES[i].link;
  return '';
}

/** The names offered by a dropdown cell (a list, or a range of cells). */
function getDropdownOptions_(dv) {
  if (!dv) return [];
  const out = [];
  const add = v => { const t = toStr_(v).trim(); if (t && out.indexOf(t) === -1) out.push(t); };
  try {
    const type = dv.getCriteriaType();
    const vals = dv.getCriteriaValues();
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) (vals[0] || []).forEach(add);
    else if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) vals[0].getValues().forEach(r => r.forEach(add));
  } catch (e) { /* not a dropdown */ }
  return out;
}

/** The "Trainer P1/P2/P3" columns found in the header, with the trainer names of
 *  their dropdown (or, without a dropdown, the names already typed in that column). */
function getTrainerColumns_(sh, layout, sampleRow, values) {
  const out = [];
  const dvs = sh.getRange(sampleRow, 1, 1, layout.lastCol).getDataValidations()[0];
  const heads = sh.getRange(layout.headerRow, 1, 1, layout.lastCol).getValues()[0];
  [1, 2, 3].forEach(n => {
    const idx = layout.cols['trainer' + n];
    if (idx === undefined || idx === -1) return;
    let options = getDropdownOptions_(dvs[idx]);
    if (!options.length) values.forEach(r => { const t = toStr_(r[idx]).trim(); if (t && options.indexOf(t) === -1) options.push(t); });
    out.push({ n: n, idx: idx, label: toStr_(heads[idx]).replace(/\s+/g, ' ').trim() || ('Trainer P' + n), options: options });
  });
  return out;
}

/** Where the trainee stopped: the first stage whose box is NOT checked. */
function stageSummary_(stageCols, checks) {
  if (!stageCols.length) return null;
  const open = checks.indexOf(false);
  const i = open === -1 ? stageCols.length - 1 : open;
  return {
    label: open === -1 ? 'All stages done ✓' : stageCols[i].label,
    phase: stageCols[i].phase, step: open === -1 ? stageCols.length : i + 1, total: stageCols.length,
    allDone: open === -1
  };
}

/** Every trainee row of a shift tab (separator / blank rows are skipped). */
function readShiftPeople_(sh) {
  const layout = getSheetLayout_(sh);
  if (!layout) return { layout: null, people: [] };
  const lastRow = sh.getLastRow();
  const people = [];
  if (lastRow <= layout.headerRow) return { layout: layout, people: people };
  const c = layout.cols;
  const values = sh.getRange(layout.headerRow + 1, 1, lastRow - layout.headerRow, layout.lastCol).getValues();
  const cell = (row, idx) => idx === -1 ? '' : toStr_(row[idx]).trim();
  // stage columns (checkboxes), found from the first trainee row
  let stageCols = [];
  let trainerCols = [];
  for (let i = 0; i < values.length; i++) {
    const nid0 = cell(values[i], c.nationalId), name0 = cell(values[i], c.name);
    if ((nid0 || name0) && !(!nid0 && name0.indexOf(SEP_PREFIX) === 0)) {
      try { stageCols = getStageColumns_(sh, layout, layout.headerRow + 1 + i); } catch (e) { stageCols = []; }
      try { trainerCols = getTrainerColumns_(sh, layout, layout.headerRow + 1 + i, values); } catch (e) { trainerCols = []; }
      break;
    }
  }
  layout.stageCols = stageCols;
  layout.trainerCols = trainerCols;
  values.forEach((row, i) => {
    const nid = cell(row, c.nationalId);
    const name = cell(row, c.name);
    if (!nid && !name) return;
    if (!nid && name.indexOf(SEP_PREFIX) === 0) return; // black separator row
    const comments = [1, 2, 3, 4].map(n => cell(row, c['comment' + n]));
    const ratings = [1, 2, 3, 4].map(n => cell(row, c['rating' + n]));
    if (!comments[0]) comments[0] = cell(row, c.comment); // an old single column = Day 1
    if (!ratings[0]) ratings[0] = cell(row, c.rating);
    people.push({
      rowNum: layout.headerRow + 1 + i,
      nationalId: nid,
      name: name,
      joinDate: c.joinDate === -1 ? null : parseJoinDate_(row[c.joinDate]),
      pc: cell(row, c.pc),
      site: cell(row, c.site),
      flash: cell(row, c.flash),
      comments: comments,
      ratings: ratings,
      feedback: cell(row, c.feedback),
      trainers: [1, 2, 3].map(n => cell(row, c['trainer' + n])),
      checks: stageCols.map(sc => row[sc.idx] === true),
      stage: null
    });
    people[people.length - 1].stage = stageSummary_(stageCols, people[people.length - 1].checks);
  });
  return { layout: layout, people: people };
}

// ---------------------------------------------------------------------
// ROSTER — Name / PC / Yubikey / Join Date come from the shift tabs
// ---------------------------------------------------------------------
// Matched to "master" by National ID and to the "data base" sheet by Yubikey.
// Built once per execution.
let _rosterCache = null;

function getBatchRoster_() {
  if (_rosterCache) return _rosterCache;
  const roster = { byId: {}, byKey: {}, list: [] };
  try {
    getShiftSheets_().forEach(item => {
      readShiftPeople_(item.sheet).people.forEach(p => {
        const info = {
          nationalId: p.nationalId, name: p.name, pc: p.pc, flash: p.flash, site: p.site,
          batch: p.joinDate ? dayLabel_(p.joinDate) : '',
          joinDate: p.joinDate, sheetName: item.sheet.getName(), shift: item.shift, rowNum: p.rowNum,
          stage: p.stage
        };
        roster.list.push(info);
        if (p.nationalId) roster.byId[p.nationalId] = info;
        const k = yubikeyKey_(p.flash);
        if (k) roster.byKey[k] = info;
      });
    });
  } catch (e) { /* roster stays empty */ }
  _rosterCache = roster;
  return roster;
}

function dayNumberFrom_(startDate) { return daysBetween_(startDate, new Date()) + 1; }

/** Name / PC / Yubikey / shift / site / Day number come from the shift tab. */
function overlayBatchInfo_(person) {
  const info = getBatchRoster_().byId[toStr_(person.nationalId).trim()];
  if (!info) return person;
  person.batch = info.batch || '';
  person.shift = info.shift || person.shift;
  person.room = info.site || person.room;
  if (info.name) person.name = info.name;
  if (info.pc) person.pc = info.pc;
  if (info.flash) person.flash = info.flash;
  if (info.joinDate) {
    person.startDate = dayKey_(info.joinDate);
    person.dayNumber = dayNumberFrom_(info.joinDate);
  }
  return person;
}

function rowToPerson_(row) {
  const startedAt = toStr_(row[COL.startedAt - 1]);
  const person = {
    nationalId: toStr_(row[COL.nationalId - 1]),
    name: toStr_(row[COL.name - 1]),
    pc: '',    // PC and Yubikey come from the shift tab (see overlayBatchInfo_)
    flash: '',
    room: toStr_(row[COL.location - 1]),
    shift: toStr_(row[COL.shift - 1]),
    stage: normalizeStage_(row[COL.stage - 1]),
    startedAt: startedAt,
    updatedAt: toStr_(row[COL.updatedAt - 1]),
    startDate: startedAt ? dayKey_(startOfDay_(new Date(startedAt))) : '',
    dayNumber: calcDayNumber_(startedAt)
  };
  return overlayBatchInfo_(person);
}

/** The dashboard-only notes of a trainee: 4 comments and 4 ratings. */
function parseNotes_(raw) {
  let o = {};
  try { o = JSON.parse(toStr_(raw) || '{}') || {}; } catch (e) { o = {}; }
  const fix = arr => [0, 1, 2, 3].map(i => toStr_(Array.isArray(arr) ? arr[i] : '').trim());
  return { c: [0, 1, 2, 3].map(i => toStr_(Array.isArray(o.c) ? o.c[i] : '')), r: fix(o.r) };
}

/** master rows as { nationalId: { rowNum, row, json, stage, startedAt, notes } }. */
function getEntriesMap_() {
  const m = {};
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return m;
  sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach((row, i) => {
    const nid = toStr_(row[COL.nationalId - 1]).trim();
    if (!nid) return;
    m[nid] = {
      rowNum: i + 2, row: row,
      json: parseAttendance_(row[COL.attendance - 1]),
      stage: normalizeStage_(row[COL.stage - 1]),
      startedAt: toStr_(row[COL.startedAt - 1]),
      notes: parseNotes_(row[COL.notes - 1])
    };
  });
  return m;
}

/** Creates the master row of a trainee that is in a shift tab but has no row yet. */
function appendEntriesRowFromRoster_(sheet, nationalId, info) {
  const r = Math.max(sheet.getLastRow(), 1) + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), r - sheet.getMaxRows());
  sheet.getRange(r, COL.nationalId, 1, 2).setNumberFormat('@');
  sheet.getRange(r, COL.joinDate).setNumberFormat('M/d');
  const row = [
    info.name || '', info.joinDate || '', nationalId, '', '', info.shift || '', info.site || '',
    STAGE_ORDER[0], '', new Date().toISOString(), '{}', ''
  ];
  sheet.getRange(r, 1, 1, HEADERS.length).setValues([row]);
}

// ---------------------------------------------------------------------
// ATTENDANCE (computed — there is no Attend sheet)
// ---------------------------------------------------------------------
// Day 1 = the Join Date. For every day up to today:
//   a value typed in the dashboard (P / O / E / T / 0)        -> that value
//   a check-in ("present")                                    -> T1, T2, T3, then TP
//   a day that passed with nothing                            -> 0
//   today with nothing yet                                    -> "" (still open)
function computeAttendanceValues_(startDate, json) {
  if (!startDate) return [];
  const start = startOfDay_(startDate);
  const n = daysBetween_(start, new Date()) + 1;
  if (n < 1) return [];
  json = json || {};
  const vals = [];
  let present = 0;
  for (let k = 0; k < Math.min(n, 400); k++) {
    const raw = toStr_(json[dayKey_(addDays_(start, k))]).trim();
    let v;
    if (raw === '') v = (k < n - 1) ? '0' : '';
    else if (raw === 'present') { present++; v = present <= 3 ? 'T' + present : 'TP'; }
    else { v = raw; if (raw !== '0') present++; }
    vals.push(v);
  }
  return vals;
}

/** Start day of a trainee: the Join Date, otherwise the first check-in. */
function startDateFor_(info, entry) {
  if (info && info.joinDate) return info.joinDate;
  if (entry && entry.startedAt) { const d = new Date(entry.startedAt); if (!isNaN(d.getTime())) return startOfDay_(d); }
  return null;
}

function presentToday_(values) {
  const v = values.length ? toStr_(values[values.length - 1]).trim() : '';
  return v !== '' && v !== '0';
}

// ---------------------------------------------------------------------
// DROPPED OUT — written to the State column of the shift tabs
// ---------------------------------------------------------------------
/** Finds the 1-based column for a field in the header row, creating the header
 *  (to the right of the last column) when it does not exist yet. */
function ensureColumn_(sh, layout, key, label) {
  const idx = layout.cols[key];
  if (idx !== -1) return idx + 1;
  layout.lastCol++;
  // the sheet may not have a spare column / row: add it first, otherwise Sheets throws
  // "The coordinates of the target range are outside the dimensions of the sheet"
  if (layout.lastCol > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), layout.lastCol - sh.getMaxColumns());
  const cell = sh.getRange(layout.headerRow, layout.lastCol);
  if (layout.lastCol > 1) sh.getRange(layout.headerRow, layout.lastCol - 1).copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  cell.setValue(label);
  layout.cols[key] = layout.lastCol - 1;
  return layout.lastCol;
}

/** Colors the red "Dropped out / Failed" rule on every shift tab
 *  that has a Feedback column. */
function applyDropoutFormatting_() {
  getShiftSheets_().forEach(item => {
    try {
      const layout = getSheetLayout_(item.sheet);
      if (layout && layout.cols.feedback !== -1) ensureDropoutRowRule_(item.sheet, layout.cols.feedback + 1);
    } catch (e) { /* non-fatal */ }
  });
}

/** Writes "Dropped out" in the State column of the shift tabs for the given National
 *  IDs. Only rows whose State is empty change, so a result you set yourself
 *  (Pass / P / Failed) is never overwritten. */
function applyDropouts_(idSet) {
  if (!Object.keys(idSet).length) return 0;
  let changed = 0;

  getShiftSheets_().forEach(item => {
    const data = readShiftPeople_(item.sheet);
    if (!data.layout) return;
    let fbCol = 0;
    data.people.forEach(p => {
      if (!p.nationalId || !idSet[p.nationalId]) return;
      if (p.feedback !== '') return; // keep whatever is already in State (Pass / Failed / ...)
      if (!fbCol) fbCol = ensureColumn_(item.sheet, data.layout, 'feedback', 'State');
      item.sheet.getRange(p.rowNum, fbCol).setValue('Dropped out');
      changed++;
    });
  });
  return changed;
}

/** Re-checks everybody: anyone with two "0" in a row before T3 gets "Dropped out". */
function syncAllAttendanceNow() {
  const entries = getEntriesMap_();
  const roster = getBatchRoster_();
  const dropped = {};
  let count = 0;
  roster.list.forEach(info => {
    if (!info.nationalId) return;
    const start = startDateFor_(info, entries[info.nationalId]);
    if (!start) return;
    count++;
    const vals = computeAttendanceValues_(start, entries[info.nationalId] ? entries[info.nationalId].json : {});
    if (hasConsecutiveAbsence_(vals)) dropped[info.nationalId] = true;
  });
  const changed = applyDropouts_(dropped);
  applyDropoutFormatting_();
  return { success: true, count: count, dropped: changed };
}
function adminSyncAllAttendance(token) {
  requireAll_(token); // SV only
  return syncAllAttendanceNow();
}

/** Installs ONE daily trigger (about 00:30) that runs syncAllAttendanceNow, so
 *  "Dropped out" is written even if nobody opens the page. Safe to run twice. */
function setupDailyAttendanceTrigger() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'syncAllAttendanceNow');
  if (has) return { success: true, already: true };
  ScriptApp.newTrigger('syncAllAttendanceNow').timeBased().everyDays(1).atHour(0).nearMinute(30).create();
  return { success: true, already: false };
}
function adminSetupDailyTrigger(token) {
  requireAll_(token); // SV only
  return setupDailyAttendanceTrigger();
}

// ---------------------------------------------------------------------
// SIGN UP  ("Login" form)  ->  the master sheet + the tab of the trainee's shift
// ---------------------------------------------------------------------

function isInMaster_(nationalId) { return !!findRow_(getSheet_(), nationalId); }

function notRegisteredMessage_(nationalId) {
  try {
    if (isInMaster_(nationalId)) return 'Your registration was received. The admin will add you to your shift soon.';
  } catch (e) { /* fall through */ }
  return 'National ID not registered. Please press Login to register first.';
}

/** Adds the sign-up as a new row of the master sheet. */
function appendToMaster_(rec) {
  const sh = getSheet_();
  const r = Math.max(sh.getLastRow(), 1) + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), r - sh.getMaxRows());
  sh.getRange(r, COL.nationalId, 1, 2).setNumberFormat('@');
  sh.getRange(r, COL.joinDate).setNumberFormat('M/d');
  sh.getRange(r, 1, 1, HEADERS.length).setValues([[
    rec.name, rec.joinDate, rec.nationalId, rec.phone, rec.gmail, rec.shift, rec.location,
    STAGE_ORDER[0], '', new Date().toISOString(), '{}', ''
  ]]);
}

/** Adds the trainee as the last row of the shift tab (copying the look of the row
 *  above, checkboxes and dropdowns included). */
function addToShiftSheet_(sh, rec) {
  let layout = getSheetLayout_(sh);
  if (!layout) throw new Error('Tab "' + sh.getName() + '": row 1-12 must contain a header row with "Name" and "National ID".');
  const c = layout.cols;
  const data = readShiftPeople_(sh);
  let lastPersonRow = layout.headerRow;
  data.people.forEach(p => { if (p.rowNum > lastPersonRow) lastPersonRow = p.rowNum; });
  const newRow = lastPersonRow + 1;
  if (newRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), newRow - sh.getMaxRows());
  if (lastPersonRow > layout.headerRow) {
    sh.insertRowAfter(lastPersonRow);
    const src = sh.getRange(lastPersonRow, 1, 1, layout.lastCol);
    const dst = sh.getRange(newRow, 1, 1, layout.lastCol);
    src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  if (c.nationalId !== -1) { const x = sh.getRange(newRow, c.nationalId + 1); x.setNumberFormat('@'); x.setValue(rec.nationalId); }
  if (c.name !== -1) sh.getRange(newRow, c.name + 1).setValue(rec.name);
  if (c.joinDate !== -1) { const x = sh.getRange(newRow, c.joinDate + 1); x.setNumberFormat('M/d'); x.setValue(rec.joinDate); }
  if (c.site !== -1) sh.getRange(newRow, c.site + 1).setValue(rec.location);
  return newRow;
}

/** Public: the sign-up form. */
function registerTrainee(entry) {
  entry = entry || {};
  const nid = toStr_(entry.nationalId).replace(/\s/g, '');
  const name = toStr_(entry.name).trim().replace(/\s+/g, ' ');
  const phone = toStr_(entry.phone).replace(/[\s-]/g, '');
  const gmail = toStr_(entry.gmail).trim().toLowerCase();
  const shift = toStr_(entry.shift).trim().toUpperCase();
  const location = toStr_(entry.location).trim().toUpperCase();

  if (!/^\d{14}$/.test(nid)) return { success: false, message: 'National ID must be 14 digits.' };
  if (name.length < 3 || name.length > 100) return { success: false, message: 'Please enter your full name.' };
  if (!/^\+?\d{10,15}$/.test(phone)) return { success: false, message: 'Please enter a valid phone number.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail) || gmail.length > 100) return { success: false, message: 'Please enter a valid Gmail address.' };
  if (REGISTER_SHIFTS.indexOf(shift) === -1) return { success: false, message: 'Please choose a shift.' };
  if (REGISTER_LOCATIONS.indexOf(location) === -1) return { success: false, message: 'Please choose a location.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (getBatchRoster_().byId[nid] || isInMaster_(nid)) {
      return { success: false, message: 'You are already registered. Please use Sign in.' };
    }
    const joinDate = startOfDay_(new Date());
    const rec = { nationalId: nid, name: name, phone: phone, gmail: gmail, shift: shift, location: location, joinDate: joinDate };

    appendToMaster_(rec);

    const ss = getSpreadsheet_();
    let shiftSheet = findShiftSheetFor_(ss, shift);
    if (!shiftSheet) { // the tab does not exist yet: create it with the basic columns
      shiftSheet = ss.insertSheet(SHIFT_SHEETS[shift][0]);
      shiftSheet.appendRow(['Name', 'Join Date', 'National ID', 'PC Training', 'Training Site']);
      shiftSheet.setFrozenRows(1);
    }
    addToShiftSheet_(shiftSheet, rec);
    try { arrangeShiftSheet_(shiftSheet); } catch (e) { /* the row is saved; the black separators can be rebuilt from Admin */ }
    return { success: true, shiftSheet: shiftSheet.getName() };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------
// BLOCKS PER JOIN DATE, separated by a black row
// ---------------------------------------------------------------------
/** Sorts a shift tab by Join Date and puts ONE black separator row (▶ 10/26) above
 *  each date's block — never between people. Safe to run again and again: its own
 *  separator rows are removed and rebuilt each time. */
function arrangeShiftSheet_(sh) {
  const layout = getSheetLayout_(sh);
  if (!layout) return { people: 0, blocks: 0, warning: 'no header row' };
  const c = layout.cols;
  if (c.joinDate === -1) return { people: 0, blocks: 0, warning: 'no Join Date column' };
  const hr = layout.headerRow, lastCol = layout.lastCol;

  // 1) remove the separator rows made earlier (bottom-up)
  let lastRow = sh.getLastRow();
  if (lastRow > hr) {
    const vals = sh.getRange(hr + 1, 1, lastRow - hr, lastCol).getValues();
    for (let i = vals.length - 1; i >= 0; i--) {
      if (!toStr_(vals[i][c.nationalId]).trim() && toStr_(vals[i][c.name]).indexOf(SEP_PREFIX) === 0) sh.deleteRow(hr + 1 + i);
    }
  }

  // 2) the rows that hold trainees, sorted by Join Date (rows without a date go last)
  lastRow = sh.getLastRow();
  if (lastRow <= hr) return { people: 0, blocks: 0 };
  const probe = sh.getRange(hr + 1, 1, lastRow - hr, lastCol).getValues();
  let n = 0;
  probe.forEach((r, i) => { if (toStr_(r[c.nationalId]).trim() || toStr_(r[c.name]).trim()) n = i + 1; });
  if (!n) return { people: 0, blocks: 0 };
  const range = sh.getRange(hr + 1, 1, n, lastCol);
  range.sort({ column: c.joinDate + 1, ascending: true });

  // 3) one separator above the first row of every date (bottom-up, so row numbers stay valid)
  const sorted = range.getValues();
  const keys = sorted.map(r => {
    if (!toStr_(r[c.nationalId]).trim() && !toStr_(r[c.name]).trim()) return null;
    const d = parseJoinDate_(r[c.joinDate]);
    return { key: d ? dayKey_(d) : 'nodate', label: d ? dayLabel_(d) : 'No date' };
  });
  let blocks = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (!keys[i]) continue;
    if (i > 0 && keys[i - 1] && keys[i - 1].key === keys[i].key) continue;
    const row = hr + 1 + i;
    sh.insertRowBefore(row);
    const rng = sh.getRange(row, 1, 1, lastCol);
    rng.clearContent();
    rng.clearDataValidations();
    rng.setBackground('#000000').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
    sh.getRange(row, c.name + 1).setValue(SEP_PREFIX + keys[i].label);
    blocks++;
  }
  return { people: n, blocks: blocks };
}

function adminArrangeShiftSheets(token) {
  requireAll_(token); // SV only
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let people = 0, blocks = 0;
    const warnings = [];
    getShiftSheets_().forEach(item => {
      const r = arrangeShiftSheet_(item.sheet);
      people += r.people; blocks += r.blocks;
      if (r.warning) warnings.push(item.sheet.getName() + ': ' + r.warning);
    });
    return { success: true, people: people, blocks: blocks, warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------
// SIGN IN (National ID only) — check-in for today
// ---------------------------------------------------------------------
/** Entries row of a trainee; created on the spot (from the shift tab) the first time. */
function getOrCreateEntriesRow_(sheet, nationalId) {
  const nid = toStr_(nationalId).trim();
  let found = findRow_(sheet, nid);
  if (found) return found;
  const info = getBatchRoster_().byId[nid];
  if (!info) return null;
  appendEntriesRowFromRoster_(sheet, nid, info);
  return findRow_(sheet, nid);
}

function lookupPerson(nationalId) {
  const found = getOrCreateEntriesRow_(getSheet_(), nationalId);
  if (!found) return { success: false, message: notRegisteredMessage_(nationalId) };
  return { success: true, person: rowToPerson_(found.row) };
}

/** The "Sign in" action: marks today as present and returns the trainee's card. */
function checkIn(nationalId) {
  // If the typed value is an admin USER NAME, ask the client for the password
  // instead of checking in (nobody is marked present for this).
  if (findUser_(nationalId)) return { success: true, needPassword: true };

  const sheet = getSheet_();
  const found = getOrCreateEntriesRow_(sheet, nationalId);
  if (!found) return { success: false, message: notRegisteredMessage_(nationalId) };

  const rowNum = found.rowNum;
  const nowIso = new Date().toISOString();
  const today = dayKey_(new Date());

  const attendance = parseAttendance_(found.row[COL.attendance - 1]);
  // keep a value typed in the dashboard (P / O / E ...); only an empty day or a "0" becomes present
  if (!attendance[today] || attendance[today] === '0') attendance[today] = 'present';

  let startedAt = toStr_(found.row[COL.startedAt - 1]);
  if (!startedAt) startedAt = nowIso;

  sheet.getRange(rowNum, COL.attendance).setValue(JSON.stringify(attendance));
  sheet.getRange(rowNum, COL.startedAt).setValue(startedAt);
  sheet.getRange(rowNum, COL.updatedAt).setValue(nowIso);

  const updatedRow = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
  return { success: true, person: rowToPerson_(updatedRow), alreadyCheckedInToday: false };
}

// ---------------------------------------------------------------------
// MY STAGE — the stages ARE the checkbox columns of the shift tab
// ---------------------------------------------------------------------
function findShiftPerson_(nationalId) {
  const nid = toStr_(nationalId).trim();
  if (!nid) return null;
  const items = getShiftSheets_();
  for (let i = 0; i < items.length; i++) {
    const data = readShiftPeople_(items[i].sheet);
    if (!data.layout) continue;
    const person = data.people.filter(p => p.nationalId === nid)[0];
    if (person) return { sheet: items[i].sheet, layout: data.layout, person: person };
  }
  return null;
}

function stageList_(stageCols, checks) {
  const open = checks.indexOf(false);
  return stageCols.map((sc, i) => ({
    id: 'c' + sc.idx, label: sc.label, phase: sc.phase, link: stageLink_(sc.label),
    done: !!checks[i], current: i === open
  }));
}

/** source "sheet": the stage list comes from the checkbox columns of the trainee's
 *  shift tab. source "static": no checkbox columns found, the page uses its own list. */
function getMyStages(nationalId) {
  const hit = findShiftPerson_(nationalId);
  if (!hit || !hit.layout.stageCols || !hit.layout.stageCols.length) return { success: true, source: 'static' };
  return { success: true, source: 'sheet', stages: stageList_(hit.layout.stageCols, hit.person.checks) };
}

/** Tap a stage = "I reached this one": every box BEFORE it gets a check mark (boxes
 *  are only ever checked here, never cleared). With finish = true the stage itself
 *  is checked too ("I finished this one"). */
function setMyStage(nationalId, stageId, finish) {
  const hit = findShiftPerson_(nationalId);
  if (!hit || !hit.layout.stageCols.length) return { success: false, message: 'No stage columns found in your shift tab.' };
  const cols = hit.layout.stageCols;
  const target = cols.findIndex(sc => 'c' + sc.idx === toStr_(stageId));
  if (target === -1) return { success: false, message: 'Unknown stage.' };
  const checks = hit.person.checks.slice();
  const last = finish ? target : target - 1;
  for (let k = 0; k <= last; k++) {
    if (!checks[k]) {
      hit.sheet.getRange(hit.person.rowNum, cols[k].idx + 1).setValue(true);
      checks[k] = true;
    }
  }
  return { success: true, source: 'sheet', stages: stageList_(cols, checks) };
}

/** The month calendar of the trainee ("My Progress" > Attendance).
 *  Status per day: present / absent / today / future / inactive. */
function getAttendanceMonth(nationalId, year, month) {
  const found = findRow_(getSheet_(), nationalId);
  if (!found) return { success: false, message: 'National ID not registered.' };
  const person = rowToPerson_(found.row);
  const info = getBatchRoster_().byId[toStr_(nationalId).trim()];
  const entry = { startedAt: person.startedAt, json: parseAttendance_(found.row[COL.attendance - 1]) };
  const start = startDateFor_(info, entry);
  const vals = computeAttendanceValues_(start, entry.json);

  const daysInMonth = new Date(year, month, 0).getDate();
  const today = startOfDay_(new Date());
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(year, month - 1, d);
    let status;
    if (!start) status = 'inactive';
    else if (dateObj.getTime() > today.getTime()) status = 'future';
    else if (dateObj.getTime() < startOfDay_(start).getTime()) status = 'inactive';
    else {
      const val = toStr_(vals[daysBetween_(start, dateObj)]).trim();
      if (dateObj.getTime() === today.getTime() && !val) status = 'today';
      else if (val && val !== '0') status = 'present';
      else status = 'absent';
    }
    days.push({ day: d, status: status });
  }
  return { success: true, person: person, daysInMonth: daysInMonth, days: days };
}

/** Sets a trainee's current stage to any stage in STAGE_ORDER — forward
 *  to advance, or backward to revisit/revert to an earlier one. The only
 *  thing rejected is a completely unknown stage id. */
function advanceStage(nationalId, stageId) {
  const sheet = getSheet_();
  const found = findRow_(sheet, nationalId);
  if (!found) return { success: false, message: 'National ID not registered.' };

  const targetIdx = STAGE_ORDER.indexOf(toStr_(stageId));
  if (targetIdx === -1) return { success: false, message: 'Unknown stage.' };

  const nowIso = new Date().toISOString();
  sheet.getRange(found.rowNum, COL.stage).setValue(toStr_(stageId));
  sheet.getRange(found.rowNum, COL.updatedAt).setValue(nowIso);

  return { success: true, stage: toStr_(stageId), updatedAt: nowIso };
}

// ---------------------------------------------------------------------
// ADMIN (user name + password from the "users" sheet)
// ---------------------------------------------------------------------
// ---- "users" sheet ----
function getUsersSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET_NAME);
    sheet.appendRow(['user', 'password']);
    sheet.setFrozenRows(1);
    sheet.getRange('A2:B').setNumberFormat('@'); // keep user / password as text
    try { sheet.hideSheet(); } catch (e) { /* needs at least one other visible tab */ }
  }
  return sheet;
}

/** Which shifts a section title of the "users" sheet allows:
 *  SV -> everything; OverNight-users -> ON; Night -> N; Morning -> M. */
function scopeFromSection_(label) {
  const k = sheetKey_(label);
  if (k === 'sv' || k === 'svusers' || k === 'all' || k === 'admin' || k === 'admins') return 'ALL';
  if (/^over|dorm/.test(k)) return ['ON'];
  if (/morning/.test(k)) return ['M'];
  if (/night/.test(k)) return ['N'];
  return []; // unknown section: can log in but sees no shift
}

/** A photo link from the "users" sheet -> an address an <img> can show.
 *  Google Drive share links (…/file/d/ID/view or …open?id=ID) become a thumbnail link;
 *  any other https link is used as it is. */
function photoUrl_(raw) {
  const t = toStr_(raw).trim();
  if (!t) return '';
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(t) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(t);
  if (m && /drive\.google\.com|docs\.google\.com/.test(t)) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w600';
  return /^https:\/\//i.test(t) ? t : '';
}

/** "OverNight-users" -> "OverNight" (the line shown under the name when no title is given). */
function sectionTitle_(section) { return toStr_(section).replace(/[\s_-]*users?$/i, '').trim(); }

/** The "users" sheet is split in sections. A row with a title in column A and an
 *  EMPTY password is a section title (SV / OverNight-users / Night / Morning...);
 *  the users under it get that section's access. Users above the first section
 *  keep full access. Optional columns (found by header, default C and D):
 *  photo (a link to the picture) and title (the small line under the name).
 *  Returns [{ user, password, scope, section, photo, title }]. */
function readUsers_() {
  const sheet = getUsersSheet_();
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 4)).getValues();
  const first = normHeader_(values[0][0]);
  const hasHeader = first === 'user' || first === 'users' || first === 'username';
  const heads = hasHeader ? values[0].map(normHeader_) : [];
  const findCol = (names, dflt) => { const i = heads.findIndex(h => names.indexOf(h) !== -1); return i !== -1 ? i : dflt; };
  const pCol = findCol(['password', 'pass', 'pw'], 1);
  const photoCol = findCol(['photo', 'image', 'picture', 'img', 'photolink', 'imagelink', 'link', 'avatar'], 2);
  const titleCol = findCol(['title', 'role', 'team', 'position', 'job'], 3);
  const out = [];
  let scope = 'ALL', section = '';
  for (let i = hasHeader ? 1 : 0; i < values.length; i++) {
    const user = toStr_(values[i][0]).trim();
    if (!user) continue;
    const password = toStr_(values[i][pCol]);
    if (password === '') { scope = scopeFromSection_(user); section = user; continue; } // section title
    out.push({
      user: user, password: password, scope: scope, section: section,
      photo: photoUrl_(values[i][photoCol]), title: toStr_(values[i][titleCol]).trim()
    });
  }
  return out;
}

function findUser_(username) {
  const u = toStr_(username).trim().toLowerCase();
  if (!u) return null;
  const list = readUsers_();
  for (let i = 0; i < list.length; i++) {
    if (list[i].user.toLowerCase() === u) return list[i];
  }
  return null;
}

// ---- tokens ----
function getAdminTokens_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(ADMIN_TOKENS_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object' && x.t) : [];
  } catch (e) { return []; }
}

/** Creates a secret token for this user (kept server-side, last 20 only). */
function issueAdminToken_(username) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const tokens = getAdminTokens_();
  tokens.push({ t: token, u: toStr_(username) });
  PropertiesService.getScriptProperties().setProperty(ADMIN_TOKENS_KEY, JSON.stringify(tokens.slice(-20)));
  return token;
}

/** Who this token belongs to: { user, all, shifts } or null. Looked up live in the
 *  "users" sheet, so deleting a row (or moving it to another section) applies at once. */
function adminInfo_(token) {
  const t = toStr_(token);
  if (!t) return null;
  const entry = getAdminTokens_().filter(x => x.t === t)[0];
  if (!entry) return null;
  if (entry.u === '__test__') return { user: 'test', all: true, shifts: [], photo: '', title: '' };
  const u = findUser_(entry.u);
  if (!u) return null;
  return {
    user: u.user, all: u.scope === 'ALL', shifts: u.scope === 'ALL' ? [] : u.scope,
    photo: u.photo, title: u.title || sectionTitle_(u.section)
  };
}
function isAdminUnlocked_(token) { return !!adminInfo_(token); }
/** Only SV (full access) may pass. */
function requireAll_(token) {
  const info = adminInfo_(token);
  if (!info) throw new Error('Not authorized.');
  if (!info.all) throw new Error('Only SV can do this.');
  return info;
}
/** SV sees every shift; the others only the shifts of their section. */
function shiftAllowed_(info, shift) { return info.all || info.shifts.indexOf(shift) !== -1; }
/** data base "SHIFT" values (M / N / ON / Morning / Night / OverNight...) -> M | N | ON */
function normShiftCode_(v) {
  const k = sheetKey_(v);
  if (k === 'on' || /^over|dorm/.test(k)) return 'ON';
  if (k === 'm' || /morning/.test(k)) return 'M';
  if (k === 'n' || /^night/.test(k)) return 'N';
  return '';
}
function isAdminUnlocked(token) { return adminInfo_(token) || false; }

/** Admin login: username + password from the "users" sheet. Returns a token.
 *  Locks a username for 10 minutes after 5 wrong attempts. */
function adminLogin(username, password) {
  const u = toStr_(username).trim();
  const cache = CacheService.getScriptCache();
  const key = 'loginfail_' + u.toLowerCase().slice(0, 100);
  const fails = parseInt(cache.get(key) || '0', 10);
  if (fails >= 5) return { success: false, message: 'Too many attempts. Try again in 10 minutes.' };

  const user = findUser_(u);
  if (!user || user.password === '' || toStr_(password) !== user.password) {
    cache.put(key, String(fails + 1), 600);
    return { success: false, message: 'Wrong user or password.' };
  }
  cache.remove(key);
  return {
    success: true, token: issueAdminToken_(user.user), user: user.user,
    all: user.scope === 'ALL', shifts: user.scope === 'ALL' ? [] : user.scope,
    photo: user.photo, title: user.title || sectionTitle_(user.section)
  };
}

/** Logs this device out (invalidates its token). */
function lockAdmin(token) {
  try {
    const t = toStr_(token);
    const tokens = getAdminTokens_().filter(x => x.t !== t);
    PropertiesService.getScriptProperties().setProperty(ADMIN_TOKENS_KEY, JSON.stringify(tokens));
  } catch (e) {}
  return true;
}

/** Emergency: run from the Apps Script editor to log out EVERY admin device. */
function revokeAllAdminTokens() {
  PropertiesService.getScriptProperties().deleteProperty(ADMIN_TOKENS_KEY);
  Logger.log('All admin tokens revoked.');
}


/** Pre-registers a trainee in the master sheet (the PC and Yubikey are read from the
 *  shift tab). National ID must be unique. */
function adminAddPerson(entry, token) {
  requireAll_(token); // SV only
  const sheet = getSheet_();
  const nationalId = toStr_(entry.nationalId).trim();
  if (!nationalId) throw new Error('National ID is required.');
  if (findRow_(sheet, nationalId)) throw new Error('This National ID is already registered.');

  const r = Math.max(sheet.getLastRow(), 1) + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), r - sheet.getMaxRows());
  sheet.getRange(r, COL.nationalId, 1, 2).setNumberFormat('@');
  sheet.getRange(r, COL.joinDate).setNumberFormat('M/d');
  sheet.getRange(r, 1, 1, HEADERS.length).setValues([[
    toStr_(entry.name), startOfDay_(new Date()), nationalId, '', '', toStr_(entry.shift), toStr_(entry.room),
    toStr_(entry.stage) || STAGE_ORDER[0], '', new Date().toISOString(), '{}', ''
  ]]);
  return { success: true };
}

function adminDeletePerson(nationalId, token) {
  requireAll_(token); // SV only
  const sheet = getSheet_();
  const found = findRow_(sheet, nationalId);
  if (!found) throw new Error('Not found.');
  sheet.deleteRow(found.rowNum);
  return { success: true };
}

/** The "All Trainees" table: everybody in the shift tabs (plus Entries-only people). */
function adminGetAllPeople(token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  const entries = getEntriesMap_();
  const roster = getBatchRoster_();
  const out = [];
  const seen = {};
  roster.list.forEach(info => {
    if (!info.nationalId || !shiftAllowed_(who, info.shift)) return;
    seen[info.nationalId] = true;
    const entry = entries[info.nationalId];
    const vals = computeAttendanceValues_(startDateFor_(info, entry), entry ? entry.json : {});
    out.push({
      name: info.name, nationalId: info.nationalId, pc: info.pc, flash: info.flash, room: info.site,
      stage: entry ? entry.stage : '', stageInfo: info.stage || null, dayNumber: vals.length || null,
      todayStatus: presentToday_(vals) ? 'present' : 'absent'
    });
  });
  Object.keys(entries).forEach(nid => {
    if (seen[nid] || !who.all) return; // Entries-only people belong to no shift: SV only
    const p = rowToPerson_(entries[nid].row);
    const vals = computeAttendanceValues_(startDateFor_(null, entries[nid]), entries[nid].json);
    p.todayStatus = presentToday_(vals) ? 'present' : 'absent';
    p.dayNumber = vals.length || null;
    out.push(p);
  });
  return out;
}

// ---------------------------------------------------------------------
// TEAMS (admin-only) — one block per shift tab + join date
// ---------------------------------------------------------------------
function teamPerson_(p, sheetName, entries) {
  const entry = entries[p.nationalId];
  const attend = computeAttendanceValues_(p.joinDate || startDateFor_(null, entry), entry ? entry.json : {});
  return {
    key: sheetName + '|' + p.rowNum, batch: sheetName, rowNum: p.rowNum,
    nationalId: p.nationalId, name: p.name, pc: p.pc,
    flash: p.flash,
    comments: entry ? entry.notes.c : ['', '', '', ''],
    ratings: entry ? entry.notes.r : ['', '', '', ''],
    feedback: p.feedback, trainers: p.trainers,
    attend: attend, dayNumber: attend.length || null,
    stage: entry ? entry.stage : '',
    stageInfo: p.stage || null,
    todayStatus: presentToday_(attend) ? 'present' : 'absent',
    days: 3, passValue: 'Pass'
  };
}

function adminGetTeams(token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  const entries = getEntriesMap_();
  const batches = [];
  getShiftSheets_().filter(item => shiftAllowed_(who, item.shift)).forEach(item => {
    const sname = item.sheet.getName();
    const data = readShiftPeople_(item.sheet);
    if (!data.layout) {
      batches.push({ name: sname, people: [], warning: 'Rows 1-12 must contain a header row with "Name" and "National ID".', _t: 9e15 });
      return;
    }
    const groups = {};
    data.people.forEach(p => {
      const key = p.joinDate ? dayKey_(p.joinDate) : 'nodate';
      (groups[key] = groups[key] || { date: p.joinDate, people: [] }).people.push(p);
    });
    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const people = g.people.map(p => teamPerson_(p, sname, entries));
      people.sort((a, b) => (a.pc || '').localeCompare(b.pc || '', undefined, { numeric: true }));
      batches.push({ name: sname + ' ' + (g.date ? dayLabel_(g.date) : 'No date'), people: people, warning: '', trainerCols: data.layout.trainerCols || [], _t: g.date ? g.date.getTime() : 9e15 });
    });
  });
  batches.sort((a, b) => (a._t - b._t) || a.name.localeCompare(b.name));
  batches.forEach(b => { delete b._t; });
  return { success: true, batches: batches };
}

/** Saves what is typed in the Teams card:
 *   - Pass / P / Failed / Dropped out -> the "State" column of the shift tab
 *   - the trainers                    -> the "Trainer P1/P2/P3" columns of the shift tab
 *   - comments + ratings (Day 1-3)    -> the dashboard (the "dashboard" column of the master
 *     sheet). Each day's COMMENT is also added as a note on the Trainer P1/P2/P3 cell of
 *     that day; ratings stay in the dashboard only. */
function adminSaveComment(sheetName, rowNum, comments, ratings, feedback, trainers, token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  if (!isShiftSheetName_(sheetName)) throw new Error('Invalid sheet.');
  const sh = findSheetByKey_(getSpreadsheet_(), sheetName);
  if (!sh) throw new Error('Sheet not found.');
  const sItem = getShiftSheets_().filter(it => it.sheet.getName() === sh.getName())[0];
  if (!sItem || !shiftAllowed_(who, sItem.shift)) throw new Error('Not allowed.');
  const layout = getSheetLayout_(sh);
  if (!layout) throw new Error('No header row (Name + National ID) in this tab.');
  const r = parseInt(rowNum, 10);
  if (!r || r <= layout.headerRow || r > sh.getLastRow()) throw new Error('Row not found.');

  const cm = [0, 1, 2, 3].map(i => toStr_(Array.isArray(comments) ? comments[i] : ''));
  const rt = [0, 1, 2, 3].map(i => toStr_(Array.isArray(ratings) ? ratings[i] : '').trim());
  rt.forEach(v => { if (v !== '' && !/^[1-5]$/.test(v)) throw new Error('Rating must be 1 to 5.'); });
  const fb = toStr_(feedback).trim();
  if (fb !== '' && FEEDBACK_VALUES.indexOf(fb) === -1) throw new Error('Invalid feedback.');
  const nid = toStr_(sh.getRange(r, layout.cols.nationalId + 1).getValue()).trim();
  if (!nid) throw new Error('This row has no National ID: add it in the sheet first.');

  // comments + ratings: dashboard only
  const master = getSheet_();
  const found = getOrCreateEntriesRow_(master, nid);
  if (!found) throw new Error('Trainee not found.');
  const oldNotes = parseNotes_(found.row[COL.notes - 1]); // what was saved before (to see which comments changed)
  master.getRange(found.rowNum, COL.notes).setValue(JSON.stringify({ c: cm, r: rt }));

  // Pass / P / Failed / Dropped out -> State
  const stateCol = ensureColumn_(sh, layout, 'feedback', 'State');
  sh.getRange(r, stateCol).setValue(fb);

  // trainers: written into the existing "Trainer P1/P2/P3" columns (never created)
  if (Array.isArray(trainers)) {
    [1, 2, 3].forEach(n => {
      const idx = layout.cols['trainer' + n];
      if (idx !== undefined && idx !== -1 && trainers[n - 1] !== undefined) sh.getRange(r, idx + 1).setValue(toStr_(trainers[n - 1]).trim());
    });
  }

  // each day's comment is ALSO put on the sheet as a note on that day's trainer cell:
  // Day 1 -> "Trainar P1", Day 2 -> "Trainar P2", Day 3 -> "Trainar P3". The note starts with
  // who wrote it and when. Only comments that CHANGED are rewritten, so the time of an old
  // comment stays; an emptied comment removes its note.
  try {
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'h:mm a MMM d');
    [1, 2, 3].forEach(n => {
      const idx = layout.cols['trainer' + n];
      if (idx === undefined || idx === -1) return;
      const text = cm[n - 1].trim();
      if (text === toStr_(oldNotes.c[n - 1]).trim()) return;
      sh.getRange(r, idx + 1).setNote(text ? (who.user + ' · ' + stamp + '\n' + text) : '');
    });
  } catch (e) { /* the comment is saved in the dashboard anyway */ }

  try { ensureDropoutRowRule_(sh, stateCol); } catch (e) { /* non-fatal */ }
  return { success: true };
}

// ---------------------------------------------------------------------
// ATTENDANCE TAB (admin-only) — the attendance lives here, not in a sheet
// ---------------------------------------------------------------------
/** Attendance grids: one block per shift tab + join date. */
function adminGetAttendance(filters, token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  filters = filters || {};
  const entries = getEntriesMap_();
  const shifts = getShiftSheets_().filter(item => shiftAllowed_(who, item.shift));
  const out = { success: true, sheets: shifts.map(s => s.sheet.getName()), batches: [] };
  shifts.forEach(item => {
    const sname = item.sheet.getName();
    if (filters.sheet && filters.sheet !== sname) return;
    const groups = {};
    readShiftPeople_(item.sheet).people.forEach(p => {
      if (!p.nationalId || !p.joinDate) return;
      const key = dayKey_(p.joinDate);
      (groups[key] = groups[key] || { date: p.joinDate, people: [] }).people.push(p);
    });
    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const n = Math.max(daysBetween_(g.date, new Date()) + 1, 0);
      const keys = [], days = [];
      for (let k = 0; k < Math.min(n, 400); k++) { const d = addDays_(g.date, k); keys.push(dayKey_(d)); days.push(dayLabel_(d)); }
      out.batches.push({
        sheet: sname, label: dayLabel_(g.date), key: key, days: days, keys: keys,
        people: g.people.map(p => {
          const entry = entries[p.nationalId];
          const values = computeAttendanceValues_(g.date, entry ? entry.json : {});
          return { nationalId: p.nationalId, name: p.name, pc: p.pc, values: values, dropped: hasConsecutiveAbsence_(values) };
        })
      });
    });
  });
  out.batches.sort((a, b) => a.key.localeCompare(b.key) || a.sheet.localeCompare(b.sheet));
  return out;
}

/** Sets (or clears) one day of one trainee. value: '' (automatic) | present | 0 | P | O | E | T */
function adminSetAttendance(nationalId, dateKey, value, token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  const nid = toStr_(nationalId).trim();
  const day = toStr_(dateKey);
  const val = toStr_(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid date.');
  if (['', 'present', '0', 'P', 'O', 'E', 'T'].indexOf(val) === -1) throw new Error('Invalid value.');

  if (!who.all) { // a shift user may only touch trainees of their own shift
    const ri = getBatchRoster_().byId[nid];
    if (!ri || who.shifts.indexOf(ri.shift) === -1) throw new Error('Not allowed.');
  }
  const sheet = getSheet_();
  const found = getOrCreateEntriesRow_(sheet, nid);
  if (!found) throw new Error('Trainee not found.');
  const json = parseAttendance_(found.row[COL.attendance - 1]);
  if (val === '') delete json[day]; else json[day] = val;
  sheet.getRange(found.rowNum, COL.attendance).setValue(JSON.stringify(json));

  const info = getBatchRoster_().byId[nid];
  const values = computeAttendanceValues_(startDateFor_(info, { startedAt: toStr_(found.row[COL.startedAt - 1]) }), json);
  const dropped = hasConsecutiveAbsence_(values);
  if (dropped) { applyDropouts_({ [nid]: true }); applyDropoutFormatting_(); }
  return { success: true, values: values, dropped: dropped };
}

// ---------------------------------------------------------------------
// DASHBOARD (admin-only) — reads from the existing "data base" sheet
// ---------------------------------------------------------------------
// This is a separate, pre-existing sheet (not created/managed by this
// script) that logs labeling submissions. Columns are found by HEADER NAME (see
// DB_HEADER_ALIASES); the layout below is only the fallback position (1-based):
// 1 TIMESTAMP | 2 SHIFT | 3 UNIT | 4 QTC NAME | 5 YUBIKEY EMAIL |
// 6 LABELER NAME | 7 PC NO | 8 MODALITY | 9 QUEUE NAME | 10 ID |
// 11 OBJECT COUNT | 12 PASS | 13 STAGE | 14 CREATED AT
const DATABASE_SHEET_NAME = 'data base';
const DB_COL = {
  timestamp: 1, shift: 2, unit: 3, qtcName: 4, yubikeyEmail: 5, labelerName: 6,
  pcNo: 7, modality: 8, queueName: 9, id: 10, objectCount: 11, pass: 12, stage: 13, createdAt: 14
};

function getDatabaseSheet_() {
  const ss = getDataSpreadsheet_();
  const sheet = ss.getSheetByName(DATABASE_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + DATABASE_SHEET_NAME + '" not found.');
  return sheet;
}

/** Formats a cell value for display: Date objects become a readable
 *  "MM/dd/yyyy, h:mm:ss a" string (like the sheet shows them); everything
 *  else is coerced to a plain string. */
function formatDbCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'GMT', 'MM/dd/yyyy, h:mm:ss a');
  }
  return toStr_(v);
}

// Header names the "data base" sheet may use for each field (case / spaces /
// symbols ignored, first match wins). Because columns are found by NAME you can
// freely reorder the sheet's columns. If a header is not found, the old fixed
// position in DB_COL is used as a fallback.
const DB_HEADER_ALIASES = {
  timestamp: ['timestamp', 'datetime', 'time', 'date'],
  shift: ['shift'],
  unit: ['unit', 'room'],
  qtcName: ['qtcname', 'qtc'],
  yubikeyEmail: ['yubikeyemail', 'yubikey', 'email'],
  labelerName: ['labelername', 'labeler', 'name'],
  pcNo: ['pcno', 'pcnumber', 'pcname', 'pc'],
  modality: ['modality'],
  queueName: ['queuename', 'queue'],
  id: ['id', 'taskid'],
  objectCount: ['objectcount', 'objectscount', 'objects', 'count'],
  pass: ['pass', 'result'],
  stage: ['stage'],
  createdAt: ['createdat', 'created']
};

/** Maps every field -> 1-based column number, by header name (fallback: DB_COL). */
function resolveDbColumns_(headerRow) {
  const norm = headerRow.map(normHeader_);
  const map = {};
  Object.keys(DB_HEADER_ALIASES).forEach(key => {
    let idx = -1;
    const aliases = DB_HEADER_ALIASES[key];
    for (let i = 0; i < aliases.length && idx === -1; i++) idx = norm.indexOf(aliases[i]);
    map[key] = idx !== -1 ? idx + 1 : DB_COL[key];
  });
  return map;
}

/** Reads every row from the "data base" sheet into plain objects, using the
 *  header row to find each column. Rows with no ID are skipped. */
function readDatabaseRows_() {
  const sheet = getDatabaseSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 14);
  if (lastRow < 2) return [];
  const all = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const c = resolveDbColumns_(all[0]);
  const data = all.slice(1);

  const rows = data
    .filter(row => toStr_(row[c.id - 1]) !== '')
    .map(row => {
      const timestamp = formatDbCell_(row[c.timestamp - 1]);
      return {
        timestamp: timestamp,
        datePart: timestamp ? timestamp.split(',')[0].trim() : '',
        shift: toStr_(row[c.shift - 1]),
        unit: toStr_(row[c.unit - 1]),
        qtcName: toStr_(row[c.qtcName - 1]),
        yubikeyEmail: toStr_(row[c.yubikeyEmail - 1]),
        labelerName: toStr_(row[c.labelerName - 1]),
        pcNo: toStr_(row[c.pcNo - 1]),
        modality: toStr_(row[c.modality - 1]),
        queueName: toStr_(row[c.queueName - 1]),
        id: toStr_(row[c.id - 1]),
        objectCount: Number(row[c.objectCount - 1]) || 0,
        pass: toStr_(row[c.pass - 1]),
        stage: toStr_(row[c.stage - 1]),
        createdAt: formatDbCell_(row[c.createdAt - 1])
      };
    });

  // Name and PC come from the BATCH sheet (matched by Yubikey); the data base
  // values stay only when the Yubikey is not found in any batch.
  const roster = getBatchRoster_();
  rows.forEach(r => {
    const k = yubikeyKey_(r.yubikeyEmail);
    const info = k ? roster.byKey[k] : null;
    if (!info) return;
    if (info.name) r.labelerName = info.name;
    if (info.pc) r.pcNo = info.pc;
  });
  return rows;
}

function distinctSorted_(rows, field) {
  const seen = {};
  rows.forEach(r => { if (r[field]) seen[r[field]] = true; });
  return Object.keys(seen).sort();
}

function topCounts_(rows, field) {
  const m = {};
  rows.forEach(r => { const k = r[field] || '(none)'; m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).map(k => ({ name: k, count: m[k] })).sort((a, b) => b.count - a.count);
}

/** Main dashboard data endpoint. `filters` is optional:
 *  { date, shift, modality, queueName, pass } — each a single exact-match
 *  string, or omitted/empty to not filter on that dimension.
 *  Returns everything the Dashboard tab needs in one call: PC cards,
 *  the row-detail table (capped at 500 rows for payload size — the
 *  aggregates below are computed on the FULL filtered set, not the cap),
 *  queue totals, modality/pass breakdown, object count stats, top
 *  QTC/Labeler lists, and filter dropdown options (always from the full
 *  unfiltered dataset, so the dropdowns never shrink as you filter). */
function getDashboardData(filters, token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  filters = filters || {};

  let allRows = readDatabaseRows_();
  if (!who.all) allRows = allRows.filter(r => who.shifts.indexOf(normShiftCode_(r.shift)) !== -1); // by the SHIFT column

  let rows = allRows;
  if (filters.date) rows = rows.filter(r => r.datePart === filters.date);
  if (filters.shift) rows = rows.filter(r => r.shift === filters.shift);
  if (filters.modality) rows = rows.filter(r => r.modality === filters.modality);
  if (filters.queueName) rows = rows.filter(r => r.queueName === filters.queueName);
  if (filters.pass) rows = rows.filter(r => r.pass === filters.pass);
  if (filters.unit) rows = rows.filter(r => r.unit === filters.unit); // "Room" filter (stored as UNIT in the sheet)
  if (filters.yubikeyEmail) rows = rows.filter(r => r.yubikeyEmail === filters.yubikeyEmail);

  // ---- PC cards (grouped by PC NO) ----
  const pcMap = {};
  rows.forEach(r => {
    if (!r.pcNo) return;
    if (!pcMap[r.pcNo]) pcMap[r.pcNo] = { pcNo: r.pcNo, labelerName: '', yubikeyEmail: '', total: 0, queues: {} };
    const card = pcMap[r.pcNo];
    card.total++;
    if (r.labelerName) card.labelerName = r.labelerName;
    if (r.yubikeyEmail) card.yubikeyEmail = r.yubikeyEmail;
    card.queues[r.queueName || '(none)'] = (card.queues[r.queueName || '(none)'] || 0) + 1;
  });
  const pcCards = Object.keys(pcMap).map(k => {
    const c = pcMap[k];
    return {
      pcNo: c.pcNo, labelerName: c.labelerName, yubikeyEmail: c.yubikeyEmail, total: c.total,
      queues: Object.keys(c.queues).map(q => ({ queueName: q, count: c.queues[q] }))
    };
  }).sort((a, b) => a.pcNo.localeCompare(b.pcNo, undefined, { numeric: true }));

  // ---- Queue totals (Queue x Pass grid) ----
  const queueMap = {};
  const passSeen = {};
  rows.forEach(r => {
    const q = r.queueName || '(none)';
    const p = r.pass || '(none)';
    if (!queueMap[q]) queueMap[q] = {};
    queueMap[q][p] = (queueMap[q][p] || 0) + 1;
    passSeen[p] = true;
  });
  const passColumns = Object.keys(passSeen).sort();
  const queueRows = Object.keys(queueMap).map(q => {
    const counts = {};
    let total = 0;
    passColumns.forEach(p => { const c = queueMap[q][p] || 0; counts[p] = c; total += c; });
    return { queueName: q, counts: counts, total: total };
  });
  const grandTotal = { counts: {}, total: 0 };
  passColumns.forEach(p => grandTotal.counts[p] = 0);
  queueRows.forEach(row => { passColumns.forEach(p => grandTotal.counts[p] += row.counts[p]); grandTotal.total += row.total; });

  // ---- Modality & Pass breakdown ----
  const modPassMap = {};
  rows.forEach(r => {
    const key = (r.modality || '(none)') + ' — ' + (r.pass || '(none)');
    modPassMap[key] = (modPassMap[key] || 0) + 1;
  });
  const totalRows = rows.length;
  const modalityPass = Object.keys(modPassMap).map(k => ({
    label: k, count: modPassMap[k], pct: totalRows ? Math.round((modPassMap[k] / totalRows) * 100) : 0
  })).sort((a, b) => b.count - a.count);

  // ---- Object count ----
  const totalObjects = rows.reduce((s, r) => s + (r.objectCount || 0), 0);
  const avgPerTask = totalRows ? (totalObjects / totalRows) : 0;

  return {
    success: true,
    totalRows: totalRows,
    rows: rows.slice(0, 500),
    rowsCapped: totalRows > 500,
    pcCards: pcCards,
    queueTotals: { passColumns: passColumns, rows: queueRows, grandTotal: grandTotal },
    modalityPass: modalityPass,
    objectCount: { total: totalObjects, avgPerTask: avgPerTask, taskCount: totalRows },
    topQTC: topCounts_(rows, 'qtcName').slice(0, 15),
    topLabeler: topCounts_(rows, 'labelerName').slice(0, 15),
    filterOptions: {
      dates: distinctSorted_(allRows, 'datePart'),
      shifts: distinctSorted_(allRows, 'shift'),
      modalities: distinctSorted_(allRows, 'modality'),
      queues: distinctSorted_(allRows, 'queueName'),
      passValues: distinctSorted_(allRows, 'pass'),
      rooms: distinctSorted_(allRows, 'unit'),
      yubikeys: distinctSorted_(allRows, 'yubikeyEmail')
    }
  };
}

// ---------------------------------------------------------------------
// QUALITY (admin-only) — reads from the existing "quality" sheet
// ---------------------------------------------------------------------
// The sheet has MANY columns (per-category breakdowns etc.), and some
// header names — like "Total Accuracy" — appear more than once (e.g. a
// per-category "Total Accuracy" earlier in the row, then the real overall
// one further right). So columns are resolved DYNAMICALLY by matching the
// header row text, not by a fixed column number. When a header name
// appears more than once, the LAST (rightmost) occurrence wins, since
// that's consistently the "final/overall" column in this sheet's layout.
const QUALITY_SHEET_NAME = 'quality';
const QUALITY_HEADER_NAMES = {
  taskName: 'Task Name',
  taskId: 'Task ID',
  submittedDate: 'Submitted Date',
  email: 'Email',
  artifacts: 'Artifacts',
  attribute: 'Attribute',
  totalAccuracy: 'Total Accuracy'
};

function getQualitySheet_() {
  const ss = getDataSpreadsheet_();
  const sheet = ss.getSheetByName(QUALITY_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + QUALITY_SHEET_NAME + '" not found.');
  return sheet;
}

/** Scans the "quality" sheet's header row (row 1) and returns a map of
 *  { taskName, taskId, ... } -> 1-based column number. If a header name
 *  appears multiple times, the LAST (rightmost) match wins. Missing
 *  headers resolve to null. */
function resolveQualityColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colMap = {};
  Object.keys(QUALITY_HEADER_NAMES).forEach(key => colMap[key] = null);

  headerRow.forEach((h, idx) => {
    const hStr = toStr_(h).trim().toLowerCase();
    Object.keys(QUALITY_HEADER_NAMES).forEach(key => {
      if (hStr === QUALITY_HEADER_NAMES[key].toLowerCase()) {
        colMap[key] = idx + 1; // keep overwriting left-to-right so the LAST match wins
      }
    });
  });
  return colMap;
}

/** Formats a number as a percentage string, preserving up to 2 decimals
 *  (matching how the sheet displays it, e.g. "96.62%"). Accepts either a
 *  0-1 fraction (Sheets' native percent storage) or an already-scaled
 *  0-100 number. */
function formatPercent_(v) {
  if (v === null || v === undefined || v === '') return '';
  const num = Number(v);
  if (isNaN(num)) return toStr_(v);
  const pct = num <= 1 ? num * 100 : num;
  const rounded = Math.round(pct * 100) / 100;
  const str = rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return str + '%';
}

function readQualityRows_() {
  const sheet = getQualitySheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const colMap = resolveQualityColumns_(sheet);
  if (!colMap.taskId) {
    throw new Error('Could not find a "Task ID" column in the "quality" sheet header row.');
  }

  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const get = (row, col) => col ? row[col - 1] : '';

  return data
    .filter(row => toStr_(get(row, colMap.taskId)) !== '')
    .map(row => ({
      taskName: toStr_(get(row, colMap.taskName)),
      taskId: toStr_(get(row, colMap.taskId)),
      submittedDate: formatDbCell_(get(row, colMap.submittedDate)),
      submittedDateRaw: get(row, colMap.submittedDate),
      email: toStr_(get(row, colMap.email)),
      artifacts: formatPercent_(get(row, colMap.artifacts)),
      attribute: formatPercent_(get(row, colMap.attribute)),
      totalAccuracy: formatPercent_(get(row, colMap.totalAccuracy))
    }));
}

/** Quality dashboard data endpoint. `filters` is optional: { email } —
 *  when omitted, returns every row from every email. Task history is
 *  sorted newest-first. */
function getQualityData(filters, token) {
  const who = adminInfo_(token);
  if (!who) throw new Error('Not authorized.');
  filters = filters || {};

  let allRows = readQualityRows_();
  if (!who.all) { // only the e-mails (yubikeys) of trainees that are in the user's shifts
    const roster = getBatchRoster_();
    allRows = allRows.filter(r => { const i = roster.byKey[yubikeyKey_(r.email)]; return !!i && who.shifts.indexOf(i.shift) !== -1; });
  }
  let rows = allRows;
  if (filters.email) rows = rows.filter(r => r.email === filters.email);

  rows = rows.slice().sort((a, b) => {
    const da = (a.submittedDateRaw instanceof Date) ? a.submittedDateRaw.getTime() : 0;
    const db = (b.submittedDateRaw instanceof Date) ? b.submittedDateRaw.getTime() : 0;
    return db - da;
  });

  return {
    success: true,
    taskCount: rows.length,
    tasks: rows.map(r => ({
      taskName: r.taskName, taskId: r.taskId, submittedDate: r.submittedDate,
      artifacts: r.artifacts, attribute: r.attribute, totalAccuracy: r.totalAccuracy
    })),
    filterOptions: { emails: distinctSorted_(allRows, 'email') }
  };
}

// ---------------------------------------------------------------------
// Theme (kept from previous version)
// ---------------------------------------------------------------------
function getTheme() {
  try { return PropertiesService.getUserProperties().getProperty('theme') || 'dark'; }
  catch (e) { return 'dark'; }
}
function setTheme(mode) {
  try { PropertiesService.getUserProperties().setProperty('theme', mode); return true; }
  catch (e) { return false; }
}

