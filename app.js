/* ===== Utility ===== */
// ---- Undo/Redo (snapshot-based) ----
const undoStack = [];
const redoStack = [];
function deepClone(obj){
  try { return structuredClone(obj); } catch(e){ return JSON.parse(JSON.stringify(obj)); }
}
function runUndoable(label, fn){
  const snap = {
    patient: deepClone(patient),
    used:    deepClone(used),
    kit:     deepClone(kit),
    markers: deepClone(markers),
    logHTML: logEl.innerHTML,
    score:   score
  };
  redoStack.length = 0;
  fn();
  undoStack.push(snap);
}
function restoreSnap(snap){
  if(!snap) return;
  patient = snap.patient;
  Object.keys(used).forEach(k=> used[k] = snap.used[k]);
  Object.keys(kit).forEach(k=> kit[k] = snap.kit[k]);
  markers = snap.markers;
  logEl.innerHTML = snap.logHTML;
  score = snap.score;
  refreshInv();
  renderVitals(patient);
  updateMARCH(patient);
  updateMIST();
}
function undo(){
  const snap = undoStack.pop();
  if(!snap) return;
  const redoSnap = {
    patient: deepClone(patient),
    used:    deepClone(used),
    kit:     deepClone(kit),
    markers: deepClone(markers),
    logHTML: logEl.innerHTML,
    score:   score
  };
  redoStack.push(redoSnap);
  restoreSnap(snap);
}
function redo(){
  const snap = redoStack.pop();
  if(!snap) return;
  const undoSnap = {
    patient: deepClone(patient),
    used:    deepClone(used),
    kit:     deepClone(kit),
    markers: deepClone(markers),
    logHTML: logEl.innerHTML,
    score:   score
  };
  undoStack.push(undoSnap);
  restoreSnap(snap);
}
// Keyboard shortcuts (Ctrl/Cmd+Z / Shift+Z or Y)
window.addEventListener('keydown', (e)=>{
  const ctrl = e.ctrlKey || e.metaKey;
  if(!ctrl) return;
  if(e.key.toLowerCase()==='z' && !e.shiftKey){ e.preventDefault(); undo(); }
  if(e.key.toLowerCase()==='z' && e.shiftKey || e.key.toLowerCase()==='y'){ e.preventDefault(); redo(); }
});

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const rnd=(sd)=> (Math.random()*2-1)*sd;
const $=(sel)=>document.querySelector(sel);

const logEl = $('#log');
const clockEl = $('#clock');
const vitalsEl = $('#vitals');
const vitalsAdvEl = $('#vitalsAdvanced');
const exportBtn = $('#exportScenario');
const statusPill = $('#statusPill');

function log(msg){
  const t = patient ? patient.t : 0;
  const mm = Math.floor(t/60).toString().padStart(2,'0');
  const ss = Math.floor(t%60).toString().padStart(2,'0');
  logEl.innerHTML = `<div>[T+${mm}:${ss}] ${msg}</div>` + logEl.innerHTML;
  while (logEl.children.length > 300) logEl.lastChild?.remove(); // cap
}

/* ===== Patient model ===== */
function createPatient({moiKey, kg, ambient}){
  const base = {
    t:0, kg,
    // Cardiopulm
    HR: 110 + rnd(3), MAP: 65 + rnd(3), RR: 22 + rnd(1.5), SpO2: clamp(94 + rnd(1.5), 70, 100), EtCO2: 35,
    // Derived mechanics
    FiO2:0.21, QsQt:0.05, VE:7.0,
    // Volume & shock
    VolFrac: 0.80, Lactate: 3.2, BaseDef: 4.0, Shock: 2,
    // Coagulation & temp
    CoagIdx: 0.2, Temp: ambient==='cold'?34.5:36.5,
    // Pain & neuro
    Pain: 8, GCS: 14, AVPU:'A',
    // TBI/ICP
    tbi:false, ICP:12, pupils:'equal-reactive',
    // Bleeding & wounds
    externalBleed: false, bleedRate: 0.02,
    chestL: { open:false, tension:false, drain:false, tube:false },
    chestR: { open:false, tension:false, drain:false, tube:false },
    // Airway/vent
    airway: 'patent', airwayAdj:false, ventSupport:false, o2On:false,
    // Drugs
    drugs: { ketamine:0, fentanyl:0, midaz:0, epi:0, norepi:0 },
    ketInf:0, ke: { ketamine:0.35/60, fentanyl:0.5/60, midaz:0.4/60, epi:5/60, norepi:0.05/60 },
    // TXA/Blood/Calcium
    tTXA:null, txaActive:false, calciumGiven:false, calciumDebt:0,
    // Bundles/flags
    hpmk:false, crystTotal:0,
    // Endogenous sympathetic tone
    cat:0.6,
    // Renal perfusion & cap refill
    UO:20, capRefill:2.0,
    // Death-state tracking
    dead:false, deathReason:'', lowMapSec:0, lowSpO2Sec:0, lowVolSec:0, arrestLikely:false
  };

  if(moiKey==='blast'){ base.externalBleed=true; base.bleedRate=0.04; base.VolFrac=0.74; base.Lactate=4.5; }
  if(moiKey==='gsw_torso'){ base.bleedRate=0.035; base.VolFrac=0.78; base.chestL.open=true; base.chestL.tension=true; base.Lactate=4.0; }
  if(moiKey==='gsw_chest'){ base.chestL.open=true; base.chestL.tension=true; base.bleedRate=0.025; base.VolFrac=0.80; base.Lactate=3.6; }
  if(moiKey==='mvc'){ base.bleedRate=0.02; base.VolFrac=0.82; base.tbi=Math.random()<0.4; base.Lactate=3.2; }

  base.BaseDef = clamp(1.5*base.Lactate, 0, 20);
  return base;
}

let patient=null, score=0, baselinePain=8;
let loopId = null, lastTs = null, acc = 0;

/* ===== Score gates ===== */
const scorePill = document.getElementById('scorePill');
const used = { tourniquet:false, airwayAdjunct:false, chestCare:false, txa:false, blood:false, calcium:false };
const gates = [
  { key:'M', byMin:3,  cond: p => (p.externalBleed && p.bleedRate > 0.02), pass: () => used.tourniquet || p_bleedNearlyStopped(), penalty:2, msg:'Control hemorrhage by T+3m' },
  { key:'A', byMin:5,  cond: p => p.SpO2 < 90,                              pass: () => used.airwayAdjunct, penalty:1, msg:'Airway adjunct/position by T+5m' },
  { key:'R', byMin:6,  cond: p => p.SpO2 < 90,                              pass: () => used.chestCare,     penalty:1, msg:'Seal / decompress by T+6m' },
  { key:'C', byMin:10, cond: p => (p.VolFrac < 0.85 || p.MAP < (p.tbi?70:65)),
    pass: () => (used.blood) || (used.txa && patient.MAP >= (patient.tbi?70:65)),
    penalty:2, msg:'Resus to target MAP (TXA + hemostasis ± blood) by T+10m' },
];
function p_bleedNearlyStopped(){ return patient && patient.bleedRate <= 0.01; }
function addScore(delta, reason){ score += delta; scorePill.textContent = `Score: ${score}`; if(delta!==0) log(`${delta>0?'+':''}${delta} ${reason}`); }

/* ===== Inventory ===== */
const kit = { tq:2, seals:2, needles:2, txa:1, wb250:4, cryst500:2, calcium:2, npa:1, igel:1, hpmk:1, binder:1, norepi:1, chestTubeKit:2, sterile:2 };
function setInv(btnId, count){ const b = document.getElementById(btnId); if(!b) return; b.disabled = !count || count<=0; b.title = `Remaining: ${count}`; }
function refreshInv(){
  setInv('tourniquet', kit.tq); setInv('pelvic', kit.binder);
  setInv('seal', kit.seals); setInv('nd_left', kit.needles); setInv('nd_right', kit.needles);
  setInv('wb250', kit.wb250); setInv('cryst500', kit.cryst500); setInv('calcium', kit.calcium);
  setInv('npa', kit.npa); setInv('igel', kit.igel);
  setInv('ct_left', Math.min(kit.chestTubeKit, kit.sterile)); setInv('ct_right', Math.min(kit.chestTubeKit, kit.sterile));
}

/* ===== Interventions (PK–PD hooks) ===== */
function giveDrug(p, kind){
  if (p.dead) return;
  if (kind==='ketamine_0_3'){ p.drugs.ketamine += 0.3*p.kg; p.Pain=Math.max(0,p.Pain-3); log('Ketamine 0.3 mg/kg IV'); }
  if (kind==='fent_50'){ p.drugs.fentanyl += 0.05; p.Pain=Math.max(0,p.Pain-2); log('Fentanyl 50 μg IV'); }
  if (kind==='midaz_1'){ p.drugs.midaz += 1; log('Midazolam 1 mg IV'); }
  if (kind==='ondansetron_4'){ log('Ondansetron 4 mg IV'); }
  if (kind==='txa2g'){
    if(kit.txa>0){ kit.txa--; p.tTXA=p.t; p.txaActive=true; used.txa=true; log('TXA 2 g IV (≤3 hr window)'); refreshInv(); }
    else log('No TXA left');
  }
}
function giveWB(p, ml){
  if (p.dead) return;
  if(kit.wb250<=0){ log('No whole blood units left'); return; }
  kit.wb250--;
  const volGain=ml/(p.kg*70); p.VolFrac=clamp(p.VolFrac+volGain,0,1.2);
  p.CoagIdx = clamp(p.CoagIdx - 0.05, 0, 1);
  p.BaseDef = clamp(p.BaseDef - 0.6, 0, 20);
  p.Lactate = clamp(p.Lactate - 0.3, 0, 20);
  p.MAP += 3;
  p.calciumDebt = (p.calciumDebt||0) + ml/500;
  used.blood=true;
  log(`Whole blood ${ml} mL`); if(!p.calciumGiven) log('Reminder: give Calcium **gluconate** after blood');
  refreshInv();
}
function giveCrystalloid(p, ml){
  if (p.dead) return;
  if(kit.cryst500<=0){ log('No crystalloid left'); return; }
  kit.cryst500--;
  const volGain=ml/(p.kg*70); p.VolFrac=clamp(p.VolFrac+volGain*0.7,0,1.2);
  p.MAP += 1.5; p.crystTotal += ml;
  if(p.crystTotal>1000) { p.bleedRate = p.bleedRate + 0.01; p.CoagIdx = clamp(p.CoagIdx + 0.05, 0, 1); log('Dilutional coagulopathy risk ↑'); }
  if(p.crystTotal>2000) { p.QsQt = clamp(p.QsQt + 0.03, 0, 0.45); log('Pulmonary edema risk ↑ (oxygenation worse)'); }
  log(`Crystalloid ${ml} mL`); refreshInv();
}
function calciumGluconate(p){
  if (p.dead) return;
  if(kit.calcium<=0){ log('No calcium available'); return; }
  kit.calcium--; p.calciumGiven=true; p.calciumDebt = Math.max(0, (p.calciumDebt||0) - 1);
  log('Calcium gluconate given (after blood)'); refreshInv();
}
function tourniquet(p){ if (p.dead) return; if(kit.tq<=0){ log('Out of TQs'); return; } kit.tq--; if (p.externalBleed){ p.bleedRate*=0.2; p.externalBleed=false; used.tourniquet = true; log('Tourniquet applied (external bleed controlled)'); } else { log('TQ: no external limb hemorrhage'); } refreshInv(); }
function packWound(p){ if (p.dead) return; p.bleedRate=Math.max(p.bleedRate-0.012,0.002); log('Wound packed & pressure dressing'); }
function pelvicBinder(p){ if (p.dead) return; if(kit.binder<=0){ log('No pelvic binder'); return; } kit.binder--; p.bleedRate=Math.max(p.bleedRate-0.007,0.002); p.binderOn=true; log('Pelvic binder applied'); refreshInv(); updateMIST(); }
function airwayPosition(p){ if (p.dead) return; p.airwayAdj=true; used.airwayAdjunct=true; log('Airway positioned / jaw thrust'); }
function npa(p){ if (p.dead) return; if(kit.npa<=0){ log('No NPA'); return;} kit.npa--; p.airwayAdj=true; used.airwayAdjunct=true; log('NPA placed'); refreshInv(); }
function igel(p){ if (p.dead) return; if(kit.igel<=0){ log('No i-gel'); return;} kit.igel--; p.airway='secured'; used.airwayAdjunct=true; log('i-gel inserted'); refreshInv(); }
function cric(p){ if (p.dead) return; p.airway='secured'; used.airwayAdjunct=true; log('Surgical cricothyrotomy performed'); }
function seal(p){ if (p.dead) return; if(kit.seals<=0){ log('No seals left'); return;} kit.seals--; p.chestL.open=false; p.chestR.open=false; used.chestCare=true; log('Occlusive seal applied (bilateral)'); refreshInv(); }
function needleD(p, side){ if (p.dead) return; if(kit.needles<=0){ log('No needles left'); return;} kit.needles--; const s=(side==='L')?p.chestL:p.chestR; if(s.tension){ s.tension=false; used.chestCare=true; log(`Needle decompression successful (${side})`);} else { log(`ND (${side}) placed with no tension`); addScore(-1,'Unnecessary ND'); } refreshInv(); }
function fingerT(p, side){ if (p.dead) return; const s=(side==='L')?p.chestL:p.chestR; s.tension=false; s.drain=true; used.chestCare=true; log(`Finger thoracostomy (${side}) — CLEAN`); }
function chestTube(p, side){ if (p.dead) return; if(kit.chestTubeKit<=0 || kit.sterile<=0){ log('Chest tube needs sterile kit & field'); addScore(-1,'Attempted chest tube without sterile setup'); return; } kit.chestTubeKit--; kit.sterile--; const s=(side==='L')?p.chestL:p.chestR; s.tension=false; s.drain=true; s.tube=true; used.chestCare=true; log(`Chest tube inserted (${side}) — STERILE`); refreshInv(); }
function o2(p){ if (p.dead) return; p.o2On = true; p.FiO2 = Math.max(p.FiO2, 0.5); log('Supplemental O₂ (≈FiO₂ 0.5)'); }
function bvm(p){ if (p.dead) return; p.ventSupport=true; p.FiO2 = 1.0; log('BVM support with EtCO₂ target (35–40)'); }
function norepiOn(p){ if (p.dead) return; if(kit.norepi<=0){ log('No norepi'); return;} p.drugs.norepi=2; log('Norepinephrine started (level 2)'); }
function norepiOff(p){ p.drugs.norepi=0; log('Norepinephrine stopped'); }
function hpmk(p){ if (p.dead) return; if(kit.hpmk<=0){ log('No HPMK'); return;} kit.hpmk--; p.hpmk=true; if($('#temp').value==='cold') p.Temp = Math.max(p.Temp, 35.0); log('Hypothermia prevention kit applied'); refreshInv(); }
function tbiBundle(p){ if (p.dead) return; p.tbi=true; log('TBI bundle: SBP ≥100, EtCO₂ 35–40, head elevate'); }

/* ===== Antibiotics (scoring only) ===== */
function giveAntibiotic(kind){ if (patient?.dead) return;
  const label = { moxi_400_po:'Moxifloxacin 400 mg PO', ertapenem_1g_im_iv:'Ertapenem 1 g IM/IV', cefotetan_2g_iv:'Cefotetan 2 g IV' }[kind] || kind;
  used.antibiotics = true;
  log(`Antibiotic given: ${label}`); addScore(+1, 'Early antibiotics'); updateMIST();
}

/* ===== Wounds & Splinting ===== */
function woundIrrigate(p){ if (p.dead) return; p.bleedRate = Math.max(p.bleedRate - 0.003, 0.0015); log('Wound irrigated & debrided'); addScore(+1,'Good wound care'); }
function woundPressureDress(p){ if (p.dead) return; p.bleedRate = Math.max(p.bleedRate - 0.006, 0.0015); log('Pressure dressing applied'); }
function woundHemostatic(p){ if (p.dead) return; p.bleedRate = Math.max(p.bleedRate - 0.010, 0.0012); log('Hemostatic gauze placed'); addScore(+1,'Hemostatic use'); }
function woundReassess(p){ if (p.dead) return; log('Reassessed bleeding & dressings — no major changes'); }
function splintUpper(p){ if (p.dead) return; p.Pain = Math.max(0, p.Pain - 1.5); p.MAP += 0.5; log('Upper limb splinted'); }
function splintLower(p){ if (p.dead) return; p.Pain = Math.max(0, p.Pain - 2.0); p.MAP += 0.8; log('Lower limb splinted'); }
function slingSwathe(p){ if (p.dead) return; p.Pain = Math.max(0, p.Pain - 1.0); log('Sling & swathe applied'); }

/* ===== AVPU ===== */
function getAVPU(p){
  const g = p.GCS || 15;
  if (g >= 14) return 'A';
  if (g >= 9)  return 'V';
  if (g >= 6)  return 'P';
  return 'U';
}
function avpuClass(a){ return {A:'good',V:'warn',P:'warn',U:'bad'}[a]||''; }

/* ===== Death / Arrest logic (revised) ===== */
function checkDeath(p, moiKey){
  if (p.dead) return;

  // Timed thresholds (more realistic)
  if (p.MAP < 45) p.lowMapSec += 1; else p.lowMapSec = Math.max(0, p.lowMapSec - 0.5);
  if (p.SpO2 < 80) p.lowSpO2Sec += 1; else p.lowSpO2Sec = Math.max(0, p.lowSpO2Sec - 0.5);
  if (p.VolFrac <= 0.50) p.lowVolSec += 1; else p.lowVolSec = Math.max(0, p.lowVolSec - 0.5);

  // MOI modifiers
  const chestTension = (p.chestL.tension||p.chestR.tension);
  if (chestTension && p.t > 180) p.arrestLikely = true; // ignored tension > 3m
  if (moiKey==='blast' && (p.VolFrac<0.6 || p.CoagIdx>0.8)) p.arrestLikely = true;

  // Terminal triggers
  const asystole          = (p.HR <= 20 && p.MAP <= 30);
  const sustainedAnoxia   = (p.lowSpO2Sec >= 60);             // ≥60 s SpO2 < 80%
  const refractoryShock   = (p.lowMapSec  >= 90);             // ≥90 s MAP < 45
  const exsanguinated     = (p.lowVolSec  >= 45 && p.MAP <= 35);
  const brainDeath        = (p.tbi && p.GCS <= 3 && p.SpO2 < 75 && (p.MAP - p.ICP) < 40);

  if (asystole || sustainedAnoxia || exsanguinated || brainDeath || refractoryShock || (p.arrestLikely && p.MAP<35)){
    p.dead = true;
    if (asystole)             p.deathReason = 'Cardiac arrest (asystole/hypotension)';
    else if (sustainedAnoxia) p.deathReason = 'Hypoxic arrest (sustained anoxia)';
    else if (exsanguinated)   p.deathReason = 'Exsanguination';
    else if (brainDeath)      p.deathReason = 'Severe TBI → herniation';
    else if (refractoryShock) p.deathReason = 'Refractory shock (prolonged hypotension)';
    else                      p.deathReason = 'Decompensation';
    log(`☠️ Patient deceased — ${p.deathReason}`);
  }
}

/* ===== Engine step (decomp & comp) ===== */
let lastDecompLogAt = -999; // seconds, throttle "decompensating" message to once/min

function step(p, dtSec=1){
  if (p.dead){
    p.HR = Math.max(0, p.HR - 1*dtSec);
    p.MAP = Math.max(0, p.MAP - 1.5*dtSec);
    p.SpO2 = Math.max(0, p.SpO2 - 0.8*dtSec);
    p.EtCO2 = Math.max(0, p.EtCO2 - 0.5*dtSec);
    p.GCS = 3; p.AVPU='U';
    p.t += dtSec;
    return;
  }

  p.t += dtSec;
  const moiKey = $('#moi').value;

  // TXA window active?
  const txaActive = p.txaActive && (!p.tTXA || (p.t - p.tTXA) <= 180*60);

  // Environment temperature dynamics
  const env = $('#temp').value;
  let tempDrift = 0;
  if(env==='cold' && !p.hpmk) tempDrift = -0.02*(dtSec/60);
  if(env==='hot') tempDrift = +0.01*(dtSec/60);
  p.Temp = clamp(p.Temp + tempDrift, 30, 39);
  if(p.hpmk) p.Temp = clamp(p.Temp + 0.01*(dtSec/60), 30, 37.2);

  // Chest injury progression (seal failure removed)
  ['chestL','chestR'].forEach(k=>{
    const s = p[k];
    if(s.open && !s.tube && !s.drain && Math.random()<0.004*dtSec) s.tension = true;
    // removed: random reopening "seal failure" event for clarity in training
  });

  // Coagulopathy "triangle of death"
  const triadLoad = clamp(
    (p.Temp<35 ? (35-p.Temp)*0.12 : 0) +
    (p.BaseDef>6 ? (p.BaseDef-6)*0.05 : 0) +
    (p.VolFrac<0.75 ? (0.75-p.VolFrac)*1.2 : 0), 0, 1.5
  );
  const txaPull = used.txa?0.15:0, bloodPull = used.blood?0.2:0;
  p.CoagIdx = clamp(p.CoagIdx + (triadLoad - txaPull - bloodPull)*(dtSec/60), 0, 1);

  // Shock state
  const shockLevel = clamp(1 - p.VolFrac, 0, 1.2);

  // Resp/chest penalties
  const chestPenalty = (s)=> (s.open && !s.tube && !s.drain ? 2 : 0) + (s.tension?8:0);
  const respPenalty = chestPenalty(p.chestL) + chestPenalty(p.chestR);

  // Opioid/benzo respiratory depression
  const opioidE = p.drugs.fentanyl/(p.drugs.fentanyl+0.08);
  const benzoE  = p.drugs.midaz/(p.drugs.midaz+1.0);
  const rrDepress = (opioidE>0.7?4*(opioidE-0.7)/0.3:0) + (benzoE>0.5?2*(benzoE-0.5)/0.5:0);

  // Acid drive
  const acidDrive = clamp((p.BaseDef-4)/6, 0, 2);

  // RR model
  let RR = 14 + 8*shockLevel + acidDrive - rrDepress + (p.SpO2<90?2:0) + rnd(0.5);
  p.RR = clamp(RR, 6, 36);

  // Minute ventilation
  const VT = clamp(0.45 + 0.15*clamp((p.kg-70)/30, -0.5, 0.5), 0.3, 0.6);
  const drive = 1 + clamp((p.BaseDef-2)/6, 0, 2) + (shockLevel>0.4?0.5:0) - (rrDepress>0?0.4:0);
  p.VE = clamp(p.RR*VT*drive, 3.5, 15);

  // Shunt (tension more punishing now)
  p.QsQt = clamp(
    0.05
    + (p.chestL.open||p.chestR.open?0.07:0)
    + (p.chestL.tension||p.chestR.tension?0.18:0)
    + (p.crystTotal>1500?0.05:0)
    + (p.MAP<60?0.05:0)
  , 0.03, 0.60);

  // SpO2 from FiO2 + shunt (simplified)
  const PaO2ideal = 500*(p.FiO2||0.21) - 150/Math.max(1, p.RR);
  const PaO2 = PaO2ideal*(1 - p.QsQt);
  const SaO2 = clamp(90 + 0.25*(PaO2-60), 60, 100);
  p.SpO2 = clamp(SaO2 + (p.ventSupport?1:0), 60, 100);

  // EtCO2 from ventilation + perfusion
  const perfFactor = clamp((p.MAP-40)/30, 0, 1);
  const PaCO2 = clamp(42 - 5*(p.VE-7)/3, 25, 65);
  p.EtCO2 = clamp(PaCO2 * (0.85*perfFactor + 0.15), 10, 55);

  // Pressors decay
  p.drugs.norepi = Math.max(0, p.drugs.norepi - 0.005*dtSec);

  // Catecholamine tone target
  const targetCat = clamp(0.3 + 0.9*shockLevel - (p.VolFrac<0.6?0.3:0), 0.1, 1.0);
  p.cat = p.cat + (targetCat - p.cat)*0.02*(dtSec);

  // Pain contribution to HR
  const catHRbonus = 30*p.cat;

  // Coarse MAP penalties
  const pressorTone = (p.drugs.norepi>0? 8*p.drugs.norepi/2 : 0);

  // Calcium debt penalty
  const caPenalty = (p.calciumDebt||0)>0 ? 4*(p.calciumDebt) : 0;

  // Cardiovascular: SV/CO/MAP
  const preload = clamp(p.VolFrac, 0.5, 1.1);
  const afterload = clamp(1.0 + (p.drugs.norepi>0?0.25*p.drugs.norepi:0) + (p.cat-0.6)*0.3, 0.8, 1.6);
  const contractility = clamp(1.0 + (p.cat-0.6)*0.4 - (p.Temp<35?0.15:0) - (p.BaseDef>6?0.1:0) - (p.calciumDebt?0.1:0), 0.6, 1.3);
  const SV = clamp(70 * preload * contractility / afterload, 30, 110);
  let HR = 70 + 45*shockLevel + 4*(p.Pain/10) + catHRbonus + (p.drugs.epi>0?10:0) + (p.drugs.norepi>0?3:0) + rnd(2);
  if(p.MAP<45 || p.SpO2<82){ HR -= 10; }
  p.HR = clamp(HR, 20, 170);
  const CO = clamp(p.HR * SV / 1000, 2.5, 10);
  p.MAP = clamp( (CO*18) + pressorTone - 0.7*respPenalty - caPenalty + rnd(1.5), 30, 120);

  // Pressure-sensitive bleeding
  const bleedPressureMult = clamp((p.MAP-50)/25, 0.5, 1.6);
  const triadAmp = 1 + 0.8*p.CoagIdx + (p.Temp<35?0.25:0) + (p.BaseDef>6?0.15:0);
  const bleedLoss = p.bleedRate * bleedPressureMult * (txaActive ? 0.7 : 1.0) * triadAmp * (dtSec/60);
  p.VolFrac = clamp(p.VolFrac - bleedLoss, 0, 1.2);

  // Metabolic
  p.Lactate = clamp(p.Lactate + (0.2*clamp(1 - p.VolFrac,0,1) - 0.12*(used.blood?1:0) - 0.06*(p.MAP>65?1:0))*(dtSec/60), 0, 20);
  p.BaseDef = clamp(1.5*p.Lactate, 0, 20);

  // Vent support EtCO2 targeting for TBI
  if(p.ventSupport){
    p.EtCO2 = clamp( (p.tbi?36:38) + rnd(1), 32, 42);
  }

  // GCS & AVPU modulation
  const opioidE2 = p.drugs.fentanyl/(p.drugs.fentanyl+0.08);
  const benzoE2  = p.drugs.midaz/(p.drugs.midaz+1.0);
  const sedPenalty = 1.0*(benzoE2>0.3?1:0) + 0.5*(opioidE2>0.6?1:0) + (p.drugs.ketamine>0.6*p.kg?0.3:0);
  const hypoxiaPenalty = (p.SpO2<88)?1.0:0;
  const hypoTensionPenalty = (p.MAP<60)?1.0:0;
  p.GCS = clamp(15 - sedPenalty - hypoxiaPenalty - hypoTensionPenalty - (p.tbi?1:0), 3, 15);
  p.AVPU = getAVPU(p);

  // TBI ICP/CPP dynamics
  if(p.tbi){
    const icpDrift = (p.SpO2<92? +0.06: -0.01) + (p.EtCO2>40? +0.05: -0.02);
    p.ICP = clamp(p.ICP + icpDrift*(dtSec), 8, 35);
    const CPP = p.MAP - p.ICP;
    if(CPP < 60) p.GCS = clamp(p.GCS - 0.02*(60-CPP)*dtSec, 3, 15);
    if(p.ICP>25 && Math.random()<0.002*dtSec) p.pupils = 'asymmetric-slow';
  }

  // Drug kinetics / infusion
  p.drugs.ketamine = Math.max(0, p.drugs.ketamine*Math.exp(-p.ke.ketamine*dtSec));
  p.drugs.fentanyl = Math.max(0, p.drugs.fentanyl*Math.exp(-p.ke.fentanyl*dtSec));
  p.drugs.midaz    = Math.max(0, p.drugs.midaz   *Math.exp(-p.ke.midaz*dtSec));
  p.drugs.epi      = Math.max(0, p.drugs.epi     *Math.exp(-p.ke.epi*dtSec));
  if(p.ketInf>0) p.drugs.ketamine += p.ketInf*dtSec;

  // Perfusion proxies
  const CPPkidney = p.MAP;
  p.UO = clamp(60 * (CPPkidney-55)/25, 0, 120);
  p.capRefill = clamp(1.5 + (70 - p.MAP)/40 + (1 - p.VolFrac)*2, 1, 5);

  // Throttled decompensation log (once per minute)
  if (p.MAP<=35 || p.SpO2<=85 || p.VolFrac<=0.5) {
    if (p.t - lastDecompLogAt >= 60) {
      log('⚠️ Patient decompensating!');
      lastDecompLogAt = p.t;
    }
  }

  // Analgesia target
  const analgesia = (p.drugs.ketamine>0?2:0) + (p.drugs.fentanyl>0?1.5:0);
  const painTarget = clamp(baselinePain - analgesia, 0, 10);
  p.Pain = p.Pain + (painTarget - p.Pain)*0.02*(dtSec);

  // Death check
  checkDeath(p, moiKey);
}

/* ===== Trends buffer (5 min @ 1 Hz) ===== */
const HISTORY_LEN = 300;
const hist = { HR: [], SBP: [], MAP: [], SpO2: [], RR: [], EtCO2: [] };
function clearHistory(){ Object.keys(hist).forEach(k=>hist[k]=[]); }
function getSBP_DBP(p){
  const shock = clamp(1 - p.VolFrac, 0, 1);
  const PP = clamp(40 - 20*shock + 0.1*(p.MAP-65), 20, 70);
  const DBP = clamp(p.MAP - PP/3, 30, 110);
  const SBP = clamp(DBP + PP, 60, 220);
  return { SBP, DBP };
}
function pushHistory(p){
  const { SBP } = getSBP_DBP(p);
  const pushTrim = (arr, v)=>{ arr.push(v); if(arr.length>HISTORY_LEN) arr.shift(); };
  pushTrim(hist.HR,   p.HR);
  pushTrim(hist.SBP,  SBP);
  pushTrim(hist.MAP,  p.MAP);
  pushTrim(hist.SpO2, p.SpO2);
  pushTrim(hist.RR,   p.RR);
  pushTrim(hist.EtCO2,p.EtCO2);
}

/* ===== Sparkline drawing ===== */
function drawSpark(canvas, data, yMin, yMax, guideLow=null, guideHigh=null){
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  ctx.lineWidth = 1; ctx.globalAlpha = 0.25; ctx.strokeStyle = '#aeb6c9';
  if(guideLow!=null){ const y = h - (guideLow - yMin) / (yMax - yMin) * h; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  if(guideHigh!=null){ const y = h - (guideHigh - yMin) / (yMax - yMin) * h; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  ctx.globalAlpha = 1;

  if(!data.length) return;
  const N = data.length; const dx = (w-2) / Math.max(1, N-1);
  ctx.beginPath();
  for(let i=0;i<N;i++){ const v = clamp(data[i], yMin, yMax); const x = 1 + i*dx; const y = h - (v - yMin) / (yMax - yMin) * h; (i===0) ? ctx.moveTo(x,y) : ctx.lineTo(x,y); }
  ctx.lineWidth = 2; ctx.strokeStyle = '#6ea8fe'; ctx.stroke();

  const vLast = clamp(data[N-1], yMin, yMax); const xLast = 1 + (N-1)*dx; const yLast = h - (vLast - yMin) / (yMax - yMin) * h;
  ctx.beginPath(); ctx.arc(xLast, yLast, 2.5, 0, Math.PI*2); ctx.fillStyle = '#e9ecf1'; ctx.fill();
}
function drawTrends(){
  drawSpark(document.getElementById('trend_hr'),    hist.HR,   40, 170);
  drawSpark(document.getElementById('trend_sbp'),   hist.SBP,  60, 200, 90, 110);
  drawSpark(document.getElementById('trend_map'),   hist.MAP,  40, 120, 65, 100);
  drawSpark(document.getElementById('trend_spo2'),  hist.SpO2, 70, 100, 92, null);
  drawSpark(document.getElementById('trend_rr'),    hist.RR,    6, 36, 10, 24);
  drawSpark(document.getElementById('trend_etco2'), hist.EtCO2, 10, 50, 35, 40);
}

/* ===== Vitals & MARCH ===== */
function badge(v, goodMin, goodMax, warnMin, warnMax){
  if (warnMin===undefined){ warnMin = goodMin - (goodMax-goodMin)*0.5; }
  if (warnMax===undefined){ warnMax = goodMax + (goodMax-goodMin)*0.5; }
  if (v < warnMin || v > warnMax) return 'bad';
  if (v < goodMin || v > goodMax) return 'warn';
  return 'good';
}
function item(label,val,cls){
  return `<div class="vital"><div class="label">${label}</div><div class="value ${cls}">${val}</div></div>`;
}
function renderVitals(p){
  const { SBP } = getSBP_DBP(p);
  const SI  = SBP>0 ? p.HR / SBP : 0;
  const MSI = p.MAP>0 ? p.HR / p.MAP : 0;
  const siClass  = SI  > 1.2 ? 'bad'  : (SI  >= 0.9 ? 'warn' : 'good');
  const msiClass = MSI > 1.7 ? 'bad'  : (MSI >= 1.3 ? 'warn' : 'good');

  const tiles = [];
  tiles.push(item('HR',  `${p.HR.toFixed(0)} bpm`, badge(p.HR, 60, 120)));
  tiles.push(item('SBP', `${SBP.toFixed(0)} mmHg`, badge(SBP, 90, 140, 80, 180)));
  tiles.push(item('MAP', `${p.MAP.toFixed(0)} mmHg`, badge(p.MAP, p.tbi?70:65, 110, 55, 120)));
  tiles.push(item('SpO₂', `${p.SpO2.toFixed(0)} %`, badge(p.SpO2, 92, 100, 88, 100)));
  tiles.push(item('RR', `${p.RR.toFixed(0)} /min`, badge(p.RR, 10, 24, 8, 30)));
  tiles.push(item('Temp', `${p.Temp.toFixed(1)} °C`, badge(p.Temp, 35.0, 37.5, 34.0, 39.0)));
  tiles.push(item('Shock Index', `${SI.toFixed(2)}`, siClass));
  tiles.push(item('GCS', `${p.GCS.toFixed(0)}`, p.GCS<=8?'bad':(p.GCS<=12?'warn':'good')));
  const avpu = getAVPU(p);
  tiles.push(item('AVPU', avpu, avpuClass(avpu)));
  if (p.ventSupport || p.tbi) tiles.push(item('EtCO₂', `${p.EtCO2.toFixed(0)} mmHg`, badge(p.EtCO2, p.tbi?35:35, p.tbi?38:45, 28, 50)));

  if (p.dead){
    tiles[0] = tiles[0].replace('</div></div>', `</div><div class="dead-banner">DECEASED</div></div>`);
  }
  vitalsEl.innerHTML = tiles.join('');

  // Advanced drawer metrics
  const advTiles = [];
  advTiles.push(item('Mod. Shock Index', `${MSI.toFixed(2)}`, msiClass));
  advTiles.push(item('Lactate', `${p.Lactate.toFixed(1)} mmol/L`, p.Lactate<=2?'good':(p.Lactate<=4?'warn':'bad')));
  advTiles.push(item('Base Def.', `${p.BaseDef.toFixed(1)} mEq/L`, p.BaseDef<=4?'good':(p.BaseDef<=6?'warn':'bad')));
  advTiles.push(item('Coag', `${(p.CoagIdx*100).toFixed(0)} %`, p.CoagIdx<0.3?'good':(p.CoagIdx<0.6?'warn':'bad')));
  advTiles.push(item('Volume', `${(p.VolFrac*100).toFixed(0)} %`, badge(p.VolFrac*100, 80, 110, 60, 120)));
  const shockStage = (p.VolFrac>0.85?1:(p.VolFrac>0.75?2:(p.VolFrac>0.65?3:4)));
  advTiles.push(item('Shock Grade', `${shockStage}`, (p.VolFrac>0.85?'good':(p.VolFrac>0.75?'warn':'bad'))));
  advTiles.push(item('FiO₂', `${(p.FiO2*100).toFixed(0)} %`, badge(p.FiO2*100, 21, 100, 21, 100)));
  advTiles.push(item('Shunt (Qs/Qt)', `${(p.QsQt*100).toFixed(0)} %`, p.QsQt<10/100?'good':(p.QsQt<20/100?'warn':'bad')));
  advTiles.push(item('Min Vent (VE)', `${p.VE.toFixed(1)} L/min`, badge(p.VE, 5, 10, 3.5, 15)));
  if(p.tbi){
    const CPP = (p.MAP - p.ICP);
    advTiles.push(item('ICP', `${p.ICP.toFixed(0)} mmHg`, p.ICP<=20?'good':(p.ICP<=25?'warn':'bad')));
    advTiles.push(item('CPP', `${CPP.toFixed(0)} mmHg`, CPP>=60?'good':(CPP>=50?'warn':'bad')));
  }
  advTiles.push(item('Urine Output', `${p.UO.toFixed(0)} mL/hr`, p.UO>=60?'good':(p.UO>=30?'warn':'bad')));
  advTiles.push(item('Cap Refill', `${p.capRefill.toFixed(1)} s`, p.capRefill<=2?'good':(p.capRefill<=3?'warn':'bad')));
  advTiles.push(item('Pupils', `${p.pupils}`, (p.pupils==='equal-reactive')?'good':'bad'));
  vitalsAdvEl.innerHTML = advTiles.join('');

  // Clock & status
  const mm = Math.floor(p.t / 60).toString().padStart(2, '0');
  const ss = Math.floor(p.t % 60).toString().padStart(2, '0');
  clockEl.textContent = `T+${mm}:${ss}`;
  statusPill.textContent = `Status: ${p.dead?'DECEASED':'ACTIVE'}`;

  // keep Instructor Panel readouts in sync
  updateInstructorReadouts();
}

function updateMARCH(p){
  const m_ok = (p.bleedRate <= 0.01) || !p.externalBleed || used.tourniquet;
  set('m_state', m_ok ? 'CONTROLLED' : 'UNCONTROLLED', m_ok?'ok':'bad');
  const a_ok = (p.SpO2 >= 92) || used.airwayAdjunct || p.airway==='secured';
  set('a_state', a_ok ? 'ADEQUATE' : 'UNCLEAR', a_ok?'ok':'warn');
  const r_ok = (p.SpO2 >= 92) || (p.chestL.tension===false && p.chestR.tension===false && !p.chestL.open && !p.chestR.open) || used.chestCare;
  set('r_state', r_ok ? 'ADEQUATE' : 'COMPROMISED?', r_ok?'ok':'warn');
  const c_ok = ((p.MAP >= (p.tbi?70:65) && p.VolFrac >= 0.85) || used.blood);
  set('c_state', c_ok ? 'SUPPORTED' : 'SHOCK', c_ok?'ok':'bad');
  const h_ok = (p.Temp >= 35.0) || p.hpmk;
  set('h_state', h_ok ? 'PROTECTED' : 'RISK', h_ok?'ok':'warn');
  function set(id, text, cls){ const el=document.getElementById(id); el.textContent=text; el.classList.remove('ok','warn','bad'); el.classList.add(cls); }
}

/* ===== MIST & Gate sampling ===== */
function updateMIST(){
  if(!patient) return;
  const p = patient;
  const { SBP } = getSBP_DBP(p);

  // M — Mechanism (from the MOI control)
  const mechanism = ($('#moi')?.value || '—').trim();

  // I — Injuries (markers + chest flags + external bleed)
  const byType = (window.markers || []).reduce((acc,m)=>{
    acc[m.type] = (acc[m.type]||0) + 1;
    return acc;
  },{});
  const injuriesBits = [];
  if (byType.bleed) injuriesBits.push(`${byType.bleed} bleed`);
  if (byType.burn)  injuriesBits.push(`${byType.burn} burn`);
  if (byType.fx)    injuriesBits.push(`${byType.fx} fx`);
  if (byType.pen)   injuriesBits.push(`${byType.pen} pen`);
  if (p.externalBleed)                         injuriesBits.push('external hemorrhage');
  if (p.chestL?.open || p.chestR?.open)        injuriesBits.push('open chest wound');
  if (p.chestL?.tension || p.chestR?.tension)  injuriesBits.push('suspected tension PTX');
  const injuries = injuriesBits.length ? injuriesBits.join(', ') : 'none identified';

  // S — Signs/Symptoms (concise vitals + AVPU)
  const signs = `HR ${Math.round(p.HR)} SBP ${Math.round(SBP)} MAP ${Math.round(p.MAP)} `
              + `SpO₂ ${Math.round(p.SpO2)} RR ${Math.round(p.RR)} AVPU ${getAVPU(p)}`;

  // T — Treatments (from action flags + patient state)
  const tx = [];
  if (used.tourniquet)         tx.push('TQ');
  if (used.airwayAdjunct)      tx.push('airway adjunct/position');
  if (p.airway === 'secured')  tx.push('advanced airway');
  if (used.chestCare)          tx.push('chest care (seal/ND/CT)');
  if (used.txa)                tx.push('TXA');
  if (used.blood)              tx.push('whole blood');
  if (p.calciumGiven)          tx.push('calcium');
  if (p.o2On)                  tx.push('O₂');
  if (p.ventSupport)           tx.push('BVM');
  if (p.binderOn)              tx.push('pelvic binder');
  if (used.antibiotics)        tx.push('antibiotics');
  const treatments = tx.length ? tx.join(', ') : 'none';

  // Elapsed time
  const t = Math.floor(p.t||0);
  const mm = String(Math.floor(t/60)).padStart(2,'0');
  const ss = String(Math.floor(t%60)).padStart(2,'0');

  const mistEl = document.getElementById('mist');
  if (mistEl){
    mistEl.textContent = `M: ${mechanism}; I: ${injuries}; S: ${signs}; T: ${treatments}; T+${mm}:${ss}`;
  }
}

let lastGateMin = 0;
function onSecondTick(){
  if (!patient) return;
  pushHistory(patient);
  const tMin = patient.t / 60;
  gates.forEach(g=>{
    if (tMin >= g.byMin && lastGateMin < g.byMin && g.cond(patient) && !g.pass()){
      addScore(-g.penalty, `Gate miss [${g.key}]: ${g.msg}`);
    }
  });
  if (patient.t === 120 && !gates[0].cond(patient)) addScore(+1, 'M controlled early');
  lastGateMin = tMin;
  updateMIST();
}

/* ===== Controls / loop ===== */
function initPatient(){
  const moiKey = $('#moi').value;
  const kg = parseFloat($('#mass').value||'80');
  const ambient = $('#temp').value;
  baselinePain = 8;
  patient = createPatient({moiKey, kg, ambient});
  clearHistory(); refreshInv();
  renderVitals(patient); updateMARCH(patient);
  score = 0; scorePill.textContent = 'Score: 0'; statusPill.textContent = 'Status: READY';
  Object.keys(used).forEach(k => used[k] = false);
  const mistEl = document.getElementById('mist');
  if (mistEl){ mistEl.textContent = 'M: —; I: none identified; S: —; T: none; T+00:00'; }
  updateMIST();
  lastDecompLogAt = -999;
  log('Ready. Configure scenario and press Start.');
}
function start(){ if (!patient) initPatient(); if (loopId) return; lastTs = performance.now(); loopId = requestAnimationFrame(loop); log('▶️ Simulation started'); }
function pause(){ if (loopId){ cancelAnimationFrame(loopId); loopId = null; log('⏸️ Paused'); } }
function loop(ts){
  const dt = (ts - lastTs) / 1000; lastTs = ts; acc += dt;
  while (acc >= 1){ step(patient, 1); onSecondTick(); acc -= 1; }
  renderVitals(patient); updateMARCH(patient);
  const adv = document.getElementById('advTrends');
  if (adv && adv.open) drawTrends();
  loopId = requestAnimationFrame(loop);
}
function reset(){ pause(); initPatient(); log('🔄 Reset'); }

// Shortcuts
document.addEventListener('keydown', (e)=>{
  if(e.code==='Space'){ e.preventDefault(); if(loopId) pause(); else start(); }
  if(e.key==='r' || e.key==='R'){ reset(); }
});

/* ===== Bindings ===== */
$('#start').onclick = start; $('#pause').onclick = pause; $('#reset').onclick = reset;
document.querySelectorAll('button[data-drug]').forEach(btn=> btn.onclick = ()=>{
  if(!patient) initPatient();
  runUndoable('Drug', ()=>{ giveDrug(patient, btn.dataset.drug); renderVitals(patient); updateMARCH(patient); updateMIST(); });
});
$('#wb250').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Whole blood 250 mL', ()=>{ if(!patient) initPatient(); giveWB(patient,250); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#cryst500').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Crystalloid 500 mL', ()=>{ if(!patient) initPatient(); giveCrystalloid(patient,500); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#calcium').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Calcium gluconate', ()=>{ if(!patient) initPatient(); calciumGluconate(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#tourniquet').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Tourniquet', ()=>{ if(!patient) initPatient(); tourniquet(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#pack').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Wound pack', ()=>{ if(!patient) initPatient(); packWound(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#pelvic').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Pelvic binder', ()=>{ if(!patient) initPatient(); pelvicBinder(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#jaw').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Airway position', ()=>{ if(!patient) initPatient(); airwayPosition(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#npa').onclick = ()=>{ if(!patient) initPatient(); runUndoable('NPA', ()=>{ if(!patient) initPatient(); npa(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#igel').onclick = ()=>{ if(!patient) initPatient(); runUndoable('i-gel', ()=>{ if(!patient) initPatient(); igel(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#cric').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Surgical cric', ()=>{ if(!patient) initPatient(); cric(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#seal').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Occlusive seal', ()=>{ if(!patient) initPatient(); seal(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#nd_left').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Needle D (L)', ()=>{ if(!patient) initPatient(); needleD(patient,'L'); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#nd_right').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Needle D (R)', ()=>{ if(!patient) initPatient(); needleD(patient,'R'); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#fingerT_left').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Finger T (L)', ()=>{ if(!patient) initPatient(); fingerT(patient,'L'); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#fingerT_right').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Finger T (R)', ()=>{ if(!patient) initPatient(); fingerT(patient,'R'); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#ct_left').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Chest tube (L)', ()=>{ if(!patient) initPatient(); chestTube(patient,'L'); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#ct_right').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Chest tube (R)', ()=>{ if(!patient) initPatient(); chestTube(patient,'R'); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#o2').onclick = ()=>{ if(!patient) initPatient(); runUndoable('O2 on', ()=>{ if(!patient) initPatient(); o2(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#bvm').onclick = ()=>{ if(!patient) initPatient(); runUndoable('BVM', ()=>{ if(!patient) initPatient(); bvm(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#norepi_on').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Norepi on', ()=>{ if(!patient) initPatient(); norepiOn(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#norepi_off').onclick = ()=>{ if(!patient) initPatient(); runUndoable('Norepi off', ()=>{ if(!patient) initPatient(); norepiOff(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#hpmk').onclick = ()=>{ if(!patient) initPatient(); runUndoable('HPMK', ()=>{ if(!patient) initPatient(); hpmk(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };
$('#tbi').onclick = ()=>{ if(!patient) initPatient(); runUndoable('TBI bundle', ()=>{ if(!patient) initPatient(); tbiBundle(patient); renderVitals(patient); updateMARCH(patient); updateMIST(); }); };

document.querySelectorAll('button[data-abx]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(!patient) initPatient();
    runUndoable('Antibiotic', ()=>{ giveAntibiotic(btn.dataset.abx); updateMIST(); });
  });
});

/* Free Interventions */
(function(){
  const wrap = document.getElementById('freeBtns');
  const addBtn = document.getElementById('freeAdd');
  const labelEl = document.getElementById('freeLabel');
  const scoreEl = document.getElementById('freeScore');
  if(!wrap || !addBtn || !labelEl) return;
  function makeFree(label, delta){
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = label;
    b.addEventListener('click', ()=>{ if(!patient) initPatient(); log(`Free: ${label}`); const n = parseFloat(delta); if(!Number.isNaN(n)) addScore(n, label); });
    wrap.appendChild(b);
  }
  addBtn.addEventListener('click', ()=>{ const label = (labelEl.value || '').trim(); if(!label) return; const delta = scoreEl.value; makeFree(label, delta); labelEl.value = ''; scoreEl.value = ''; });
  ['IV Access','Splint','Reassess','Reposition'].forEach(d=> makeFree(d, 0));
})();

/* ===== Body map (front/back) — IMAGE MODE + undo/delete ===== */
const canvasFront = $('#canvasFront'); const canvasBack = $('#canvasBack');
const facingSel = $('#facing'); const woundSel = $('#woundType'); let markers = [];
function drawBodyImage(container, src, alt){
  container.innerHTML = '';
  const img = document.createElement('img'); img.src = src; img.alt = alt || ''; img.className = 'body-img'; container.appendChild(img);
  container.onclick = (e)=>{ const rect = container.getBoundingClientRect(); const x = (e.clientX - rect.left) / rect.width; const y = (e.clientY - rect.top) / rect.height; addMarker(container, x, y, facingSel.value, woundSel.value); };
}
function setFacing(){ if (facingSel.value==='front'){ canvasFront.style.display='block'; canvasBack.style.display='none'; } else { canvasFront.style.display='none'; canvasBack.style.display='block'; } }
facingSel.onchange = setFacing;
const FRONT_SRC = 'TCCC Front.jpg'; const BACK_SRC  = 'TCCC Back.jpg';
const preload = src => new Promise(res=>{ const i=new Image(); i.onload=res; i.src=src; });
Promise.all([preload(FRONT_SRC), preload(BACK_SRC)]).then(()=>{ drawBodyImage(canvasFront, FRONT_SRC, 'Front body'); drawBodyImage(canvasBack,  BACK_SRC,  'Back body'); setFacing(); });

function addMarker(container,x,y,facing,type){
  runUndoable('Add marker', ()=>{

  const div=document.createElement('div'); div.className=`marker m-${type}`; div.style.left=`${x*100}%`; div.style.top=`${y*100}%`;
  div.addEventListener('click',(ev)=>{ ev.stopPropagation(); runUndoable('Delete marker', ()=>{ div.remove();
    const i = markers.findIndex(m=>Math.abs(m.x-x)<1e-3 && Math.abs(m.y-y)<1e-3 && m.facing===facing && m.type===type);
    if(i>=0) markers.splice(i,1);
    updateMIST();
  }); });
  container.appendChild(div);
  markers.push({x:+x.toFixed(3),y:+y.toFixed(3),facing,type});
  log(`Marked ${type.toUpperCase()} on ${facing} at (${(x*100).toFixed(0)}%, ${(y*100).toFixed(0)}%)`);

  });
}
function clearMarkers(){ runUndoable('Clear markers', ()=>{ markers=[]; document.querySelectorAll('.marker').forEach(m=>m.remove()); log('Cleared wound markers'); updateMIST(); }); }
document.addEventListener('keydown', e=>{ if(e.ctrlKey && (e.key==='z' || e.key==='Z')){ const last = markers.pop(); if(!last) return; const container = last.facing==='front'?canvasFront:canvasBack; const nodes = container.querySelectorAll('.marker'); if(nodes.length) nodes[nodes.length-1].remove(); }});
$('#clearMarkers').onclick = clearMarkers;

/* ===== TCCC & AAR ===== */
function buildAARHTML() {
  const p = window.patient || null;
  const getText = (sel, fallback='—')=>{
    const n = document.querySelector(sel);
    return n?.textContent?.trim() || fallback;
  };

  const logItems = Array.from(document.querySelectorAll('#log > div'))
    .slice(0, 400) // cap to keep pages reasonable
    .map(d => `<li>${(d.textContent || '').trim()}</li>`)
    .join('');

  const M = getText('#Mstat');
  const A = getText('#Astat');
  const R = getText('#Rstat');
  const C = getText('#Cstat');
  const H = getText('#Hstat');

  const mist = getText('#mist');

  let vitals = '';
  try {
    if (p) {
      const { SBP } = getSBP_DBP(p);
      vitals = `HR ${Math.round(p.HR)} | SBP ${Math.round(SBP)} | MAP ${Math.round(p.MAP)} | SpO₂ ${Math.round(p.SpO2)} | RR ${Math.round(p.RR)}`;
    }
  } catch {}

  const meta = {
    moi:  document.querySelector('#moi')?.value || '—',
    mass: document.querySelector('#mass')?.value || '—',
    env:  document.querySelector('#temp')?.value || '—',
    eta:  document.querySelector('#eta')?.value || '—',
    score: (typeof window.score === 'number') ? window.score : '—',
  };

  const css = `
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; color:#111; margin:24px; }
    h1 { margin:0 0 4px; font-size:20px; }
    h2 { margin:20px 0 8px; font-size:16px; }
    .meta { color:#555; margin-bottom:12px; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
    .card { border:1px solid #ddd; border-radius:8px; padding:12px; }
    ul { margin:8px 0 0 18px; }
    @media print {
      body { margin:0.6in; }
      .grid { grid-template-columns: 1fr 1fr; }
    }
  `;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AAR — Combat Trauma Simulator</title>
  <style>${css}</style>
</head>
<body>
  <h1>After Action Report (AAR)</h1>
  <div class="meta">Generated: ${new Date().toLocaleString()}${vitals ? ` | Vitals: ${vitals}` : ''}</div>

  <div class="card"><h2>MIST</h2><div>${mist}</div></div>

  <div class="grid">
    <div class="card">
      <h2>MARCH Status</h2>
      <div>M: ${M}</div>
      <div>A: ${A}</div>
      <div>R: ${R}</div>
      <div>C: ${C}</div>
      <div>H: ${H}</div>
    </div>
    <div class="card">
      <h2>Scenario Meta</h2>
      <div>MOI: ${meta.moi}</div>
      <div>Mass (kg): ${meta.mass}</div>
      <div>Environment: ${meta.env}</div>
      <div>Evac ETA (min): ${meta.eta}</div>
      <div>Score: ${meta.score}</div>
    </div>
  </div>

  <div class="card">
    <h2>Event Log</h2>
    <ul>${logItems}</ul>
  </div>
</body>
</html>`;
}

$('#printAAR').onclick = ()=>{
  const w = window.open('', '_blank', 'noopener,noreferrer');
  if(!w){ alert('Please allow popups to print the AAR.'); return; }
  w.document.open();
  w.document.write(buildAARHTML());
  w.document.close();
  w.focus();
  setTimeout(()=>{ try{ w.print(); }catch(e){} }, 120);
};
exportBtn.onclick = ()=>{
  const data = { meta:{ exportedAt:new Date().toISOString() }, patient, wounds:markers, score, kit };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='scenario-export.json'; a.click();
  URL.revokeObjectURL(url); log('Exported scenario JSON');
};

/* ===== Instructor Panel — single-file version ===== */
const VITALS_CFG = [
  { key:'HR',   label:'HR',        path:'HR',      step:5,   min:20,  max:170, fmt:v=>`${v.toFixed(0)} bpm` },
  { key:'MAP',  label:'MAP',       path:'MAP',     step:5,   min:30,  max:120, fmt:v=>`${v.toFixed(0)} mmHg` },
  { key:'SpO2', label:'SpO₂',      path:'SpO2',    step:2,   min:60,  max:100, fmt:v=>`${v.toFixed(0)} %` },
  { key:'RR',   label:'RR',        path:'RR',      step:2,   min:6,   max:36,  fmt:v=>`${v.toFixed(0)} /min` },
  { key:'EtCO2',label:'EtCO₂',     path:'EtCO2',   step:1,   min:10,  max:50,  fmt:v=>`${v.toFixed(0)} mmHg` },
  { key:'Temp', label:'Temp',      path:'Temp',    step:0.2, min:33,  max:39,  fmt:v=>`${v.toFixed(1)} °C` },
  { key:'Lac',  label:'Lactate',   path:'Lactate', step:0.2, min:0.5, max:10,  fmt:v=>`${v.toFixed(1)} mmol/L` },
  { key:'BD',   label:'Base Def.', path:'BaseDef', step:0.5, min:0,   max:20,  fmt:v=>`${v.toFixed(1)} mEq/L` },
  { key:'Vol',  label:'Volume',    path:'VolFrac', step:0.02,min:0.40,max:1.10,fmt:v=>`${(v*100).toFixed(0)} %` }
];

function getProp(obj, path){ return obj?.[path]; }
function setProp(obj, path, val){ obj[path] = val; }

function nudgeVital(path, delta, min, max){
  if(!patient) return;
  const v = clamp(getProp(patient, path) + delta, min, max);
  setProp(patient, path, v);
  if(path === 'Lactate') patient.BaseDef = clamp(1.5*patient.Lactate, 0, 20);
  renderVitals(patient); updateInstructorReadouts();
  log(`Instructor: ${path} ${(delta>=0?'+':'')}${path==='VolFrac' ? (delta*100).toFixed(0)+'%' : delta} → ${v.toFixed(2)}`);
}
function setVital(path, value, min, max){
  if(!patient) return;
  const v = clamp(value, min, max);
  setProp(patient, path, v);
  if(path === 'Lactate') patient.BaseDef = clamp(1.5*patient.Lactate, 0, 20);
  renderVitals(patient); updateInstructorReadouts();
}
function renderInstructorPanel(){
  const wrap = document.getElementById('instrRows');
  if(!wrap) return;
  wrap.innerHTML = '';

  VITALS_CFG.forEach(cfg=>{
    const row = document.createElement('div');
    row.className = 'metric-row';
    row.innerHTML = `
      <div class="metric-head">
        <div class="metric-label">${cfg.label}</div>
        <div class="metric-value" data-val="${cfg.path}">—</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px">
        <div class="stepper">
          <button data-step="-1">–</button>
          <span>${cfg.step}</span>
          <button data-step="+1">+</button>
        </div>
        <div style="flex:1" class="slider-wrap">
          <input class="metric-slider" type="range"
                 min="${cfg.min}" max="${cfg.max}" step="${cfg.step}"
                 data-path="${cfg.path}">
        </div>
      </div>
    `;

    const buttons = row.querySelectorAll('.stepper button');
    const doNudge = dir => nudgeVital(cfg.path, dir>0?+cfg.step:-cfg.step, cfg.min, cfg.max);
    buttons[0].addEventListener('click', ()=>doNudge(-1));
    buttons[1].addEventListener('click', ()=>doNudge(+1));
    [buttons[0], buttons[1]].forEach((b,idx)=>{
      let tid;
      const tick = ()=>{ doNudge(idx?+1:-1); tid=setTimeout(tick,120); };
      b.addEventListener('mousedown', ()=>{ tid=setTimeout(tick,320); });
      document.addEventListener('mouseup', ()=> tid && clearTimeout(tid));
      b.addEventListener('mouseleave', ()=> tid && clearTimeout(tid));
      b.addEventListener('touchstart', ()=>{ tid=setTimeout(tick,320); }, {passive:true});
      document.addEventListener('touchend', ()=> tid && clearTimeout(tid), {passive:true});
    });

    const slider = row.querySelector('.metric-slider');
    slider.addEventListener('input', e=>{
      setVital(cfg.path, parseFloat(e.target.value), cfg.min, cfg.max);
    });

    wrap.appendChild(row);
  });

  document.getElementById('forceDecomp')?.addEventListener('click', ()=>{
    if(!patient) return;
    patient.MAP = Math.max(30, patient.MAP - 20);
    patient.SpO2 = Math.min(patient.SpO2, 82);
    patient.VolFrac = Math.max(0.5, patient.VolFrac - 0.08);
    renderVitals(patient); updateMARCH(patient);
    log('Instructor: Forced decompensation');
  });

  document.getElementById('forceDeath')?.addEventListener('click', ()=>{
    if(!patient) return;
    patient.MAP = 28; patient.HR = 22; patient.SpO2 = 70; patient.EtCO2 = 12;
    patient.dead = true; patient.deathReason = 'Instructor override';
    renderVitals(patient); updateMARCH(patient);
    log('☠️ Instructor: Forced death');
  });

  document.getElementById('forceRecomp')?.addEventListener('click', ()=>{
    if(!patient) return;
    patient.dead = false; patient.deathReason = '';
    patient.MAP = Math.max(patient.MAP, 70);
    patient.SpO2 = Math.max(patient.SpO2, 94);
    patient.VolFrac = Math.min(1.0, patient.VolFrac + 0.08);
    renderVitals(patient); updateMARCH(patient);
    log('Instructor: Forced recompensation');
  });

  updateInstructorReadouts();
}
function updateInstructorReadouts(){
  if(!patient) return;
  document.querySelectorAll('[data-val]').forEach(el=>{
    const path = el.getAttribute('data-val');
    const cfg = VITALS_CFG.find(c=>c.path===path);
    if(!cfg) return;
    const val = getProp(patient, path);
    el.textContent = cfg.fmt(val);
    const slider = el.closest('.metric-row')?.querySelector('.metric-slider');
    if(slider && document.activeElement !== slider){
      slider.value = String(clamp(val, cfg.min, cfg.max));
    }
  });
}

/* ===== Boot & Accordion (single-open) + Advanced toggle ===== */
function firstRender(){ initPatient(); renderInstructorPanel(); }
firstRender();

document.getElementById('interventionsAcc')?.addEventListener('click', (e)=>{
  const sum = e.target.closest('summary'); if(!sum) return;
  const item = sum.parentElement; if(!(item && item.tagName === 'DETAILS')) return;
  document.querySelectorAll('#interventionsAcc details[open]').forEach(d=>{ if(d !== item) d.removeAttribute('open'); });
});
document.getElementById('advTrends')?.addEventListener('toggle', (e)=>{ if(e.target.open) drawTrends(); });



// Wire Undo/Redo buttons
document.getElementById('undo')?.addEventListener('click', undo);
document.getElementById('redo')?.addEventListener('click', redo);
