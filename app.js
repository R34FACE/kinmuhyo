const STAFF = ["A", "B", "C", "D", "E", "F", "G"];
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const SHIFT_VALUES = ["出", "休", "有", "出張", "研修", "早帰り", "遅番"];
const WORK_TYPES = new Set(["出", "出張", "研修", "早帰り", "遅番"]);
const REST_TYPES = new Set(["休", "有"]);
const STAFF_B = "B";
const MAX_CONSECUTIVE_WORK = 3;
const SHIFT_ELIGIBLE_STAFF = STAFF.filter((staff) => staff !== "D" && staff !== "G");
const OFF_TARGETS = { A: 10, B: 10, C: 10, D: 9, E: 10, F: 10, G: 9 };
const MAX_ATTEMPTS = 1800;

const els = {
  year: document.getElementById("yearInput"),
  month: document.getElementById("monthInput"),
  staffInputs: document.getElementById("staffInputs"),
  earlyShift: document.getElementById("earlyShiftInput"),
  lateShift: document.getElementById("lateShiftInput"),
  staffBWeekendFixed: document.getElementById("staffBWeekendFixedInput"),
  generate: document.getElementById("generateBtn"),
  export: document.getElementById("exportBtn"),
  clear: document.getElementById("clearBtn"),
  sample: document.getElementById("sampleBtn"),
  summary: document.getElementById("summary"),
  messages: document.getElementById("messages"),
  table: document.getElementById("scheduleTable"),
};

let currentResult = null;

init();

function init() {
  const now = new Date();
  els.year.value = now.getFullYear();
  els.month.value = now.getMonth() + 1;
  renderStaffInputs();
  renderEmptyState();

  els.generate.addEventListener("click", () => {
    currentResult = generate();
    renderResult(currentResult);
  });
  els.export.addEventListener("click", exportExcel);
  els.clear.addEventListener("click", clearInputs);
  els.sample.addEventListener("click", fillSample);
  els.table.addEventListener("change", handleManualEdit);
}

function renderStaffInputs() {
  els.staffInputs.innerHTML = STAFF.map((staff) => `
    <article class="staff-card">
      <h3>スタッフ${staff}</h3>
      <div class="staff-fields">
        <label>希望公休<input data-kind="request" data-staff="${staff}" placeholder="例: 3, 8, 22"></label>
        <label>有給<input data-kind="paid" data-staff="${staff}" placeholder="例: 15"></label>
        <label>出張<input data-kind="trip" data-staff="${staff}" placeholder="例: 10, 11"></label>
        <label>研修<input data-kind="training" data-staff="${staff}" placeholder="例: 20"></label>
      </div>
    </article>
  `).join("");
}

function renderEmptyState() {
  els.summary.innerHTML = STAFF.map((staff) => `
    <div class="summary-card"><strong>${staff}</strong><span>公休: -<br>有給: -<br>土日祝休: -</span></div>
  `).join("");
  els.messages.innerHTML = `<div class="message"><h3>待機中</h3><p>年月と各スタッフの予定を入力して「自動作成」を押してください。</p></div>`;
  els.table.innerHTML = "";
}

function generate() {
  const year = clamp(Number(els.year.value), 2020, 2035);
  const month = clamp(Number(els.month.value), 1, 12);
  els.year.value = year;
  els.month.value = month;

  const daysInMonth = new Date(year, month, 0).getDate();
  const holidays = getJapaneseHolidaySet(year, month);
  const shiftOptions = getShiftOptions();
  const ruleSettings = getRuleSettings();
  const { inputs, warnings } = getInputs(daysInMonth);
  const fixedWarnings = findInputConflicts(inputs);
  const staffBInputWarnings = findStaffBBlockedInputWarnings(year, month, inputs, holidays, ruleSettings);

  let best = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = buildCandidate(year, month, daysInMonth, holidays, inputs, shiftOptions, ruleSettings, attempt);
    const validation = validateSchedule(candidate, inputs, holidays, ruleSettings);
    const score = scoreCandidate(validation, candidate, inputs, holidays, ruleSettings);
    if (!best || score < best.score) {
      best = { candidate, validation, score };
      if (score === 0) break;
    }
  }

  return {
    year,
    month,
    daysInMonth,
    holidays,
    inputs,
    shiftOptions,
    ruleSettings,
    schedule: best.candidate.schedule,
    summary: best.candidate.summary,
    errors: unique([...warnings, ...fixedWarnings, ...best.validation.errors]),
    notices: unique([...staffBInputWarnings, ...best.validation.notices, ...best.candidate.shiftNotices]),
  };
}

function getShiftOptions() {
  return {
    early: els.earlyShift.checked,
    late: els.lateShift.checked,
  };
}

function getRuleSettings() {
  return {
    staffBWeekendFixed: els.staffBWeekendFixed ? els.staffBWeekendFixed.checked : true,
  };
}

function getInputs(daysInMonth) {
  const inputs = {};
  const warnings = [];
  STAFF.forEach((staff) => {
    inputs[staff] = { request: new Set(), paid: new Set(), trip: new Set(), training: new Set() };
  });

  document.querySelectorAll("[data-kind][data-staff]").forEach((node) => {
    const staff = node.dataset.staff;
    const kind = node.dataset.kind;
    const parsed = parseDays(node.value, daysInMonth);
    parsed.invalid.forEach((part) => {
      warnings.push(`スタッフ${staff}の「${kindLabel(kind)}」に無効な日付があります: ${part}`);
    });
    inputs[staff][kind] = parsed.days;
  });

  return { inputs, warnings };
}

function parseDays(value, daysInMonth) {
  const days = new Set();
  const invalid = [];
  const raw = value
    .replace(/[、，\s]+/g, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  raw.forEach((part) => {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 1 || num > daysInMonth) {
      invalid.push(part);
    } else {
      days.add(num);
    }
  });
  return { days, invalid };
}

function buildCandidate(year, month, daysInMonth, holidays, inputs, shiftOptions, ruleSettings, attempt) {
  const schedule = [];
  const offRemaining = Object.fromEntries(STAFF.map((staff) => [staff, targetPublicOff(staff)]));

  for (let day = 1; day <= daysInMonth; day += 1) {
    const row = { day, weekday: new Date(year, month - 1, day).getDay(), cells: {} };
    STAFF.forEach((staff) => {
      const staffBFixedWorkDay = isStaffBWeekendFixedDay(staff, row, holidays, ruleSettings);
      if (staffBFixedWorkDay && inputs[staff].trip.has(day)) row.cells[staff] = "出張";
      else if (staffBFixedWorkDay && inputs[staff].training.has(day)) row.cells[staff] = "研修";
      else if (staffBFixedWorkDay) row.cells[staff] = "出";
      else if (inputs[staff].request.has(day)) row.cells[staff] = "休";
      else if (inputs[staff].trip.has(day)) row.cells[staff] = "出張";
      else if (inputs[staff].training.has(day)) row.cells[staff] = "研修";
      else if (inputs[staff].paid.has(day)) row.cells[staff] = "有";
      else row.cells[staff] = "出";
    });
    schedule.push(row);
  }

  STAFF.forEach((staff) => {
    offRemaining[staff] = Math.max(0, targetPublicOff(staff) - reflectedRequestCount(schedule, staff));
  });

  for (let day = 1; day <= daysInMonth; day += 1) {
    const row = schedule[day - 1];
    const fixedNonWork = STAFF.filter((staff) => !WORK_TYPES.has(row.cells[staff])).length;
    const maxOffToday = Math.max(0, 3 - fixedNonWork);
    const futureCapacity = publicOffCapacity(schedule, day + 1);
    const remainingTotal = sum(Object.values(offRemaining));
    const minToday = Math.max(0, remainingTotal - futureCapacity);
    const averageNeed = remainingTotal / (daysInMonth - day + 1);
    const jitter = seedRandom(attempt, day, 91) > 0.52 ? 1 : 0;
    const desired = clamp(Math.round(averageNeed + jitter), minToday, maxOffToday);

    for (let i = 0; i < desired; i += 1) {
      const choices = STAFF
        .filter((staff) => offRemaining[staff] > 0 && canSetPublicOff(schedule, day, staff, inputs, holidays, ruleSettings))
        .map((staff) => ({
          staff,
          score: offScore(schedule, day, staff, offRemaining, inputs, holidays, attempt),
        }))
        .sort((a, b) => b.score - a.score);

      if (!choices.length) break;
      const pick = choices[0].staff;
      row.cells[pick] = "休";
      offRemaining[pick] -= 1;
    }
  }

  // Repair remaining public-off counts with low-impact swaps.
  let guard = 0;
  while (sum(Object.values(offRemaining)) > 0 && guard < 500) {
    guard += 1;
    const staff = STAFF.find((name) => offRemaining[name] > 0);
    const choices = schedule
      .filter((row) => canSetPublicOff(schedule, row.day, staff, inputs, holidays, ruleSettings))
      .map((row) => ({ row, score: offScore(schedule, row.day, staff, offRemaining, inputs, holidays, attempt) }))
      .sort((a, b) => b.score - a.score);
    if (!choices.length) break;
    choices[0].row.cells[staff] = "休";
    offRemaining[staff] -= 1;
  }

  repairLongRuns(schedule, inputs, holidays, ruleSettings);
  const shiftNotices = applySelectedShiftTypes(schedule, shiftOptions, attempt);
  const summary = summarize(schedule, inputs, holidays);
  return { year, month, schedule, summary, shiftNotices };
}

function repairLongRuns(schedule, inputs, holidays, ruleSettings) {
  for (let pass = 0; pass < 80; pass += 1) {
    const summary = summarize(schedule, inputs, holidays);
    const staff = STAFF.find((name) => summary[name].maxRun > MAX_CONSECUTIVE_WORK);
    if (!staff) return;

    const run = firstLongRun(schedule, staff);
    if (!run) return;

    let changed = false;
    for (let day = run.start; day <= run.end; day += 1) {
      if (schedule[day - 1].cells[staff] !== "出") continue;
      if (!canSetPublicOff(schedule, day, staff, inputs, holidays, ruleSettings)) continue;

      schedule[day - 1].cells[staff] = "休";
      const swapDay = findPublicOffToRelease(schedule, staff, day, inputs, holidays, ruleSettings);
      if (swapDay) {
        schedule[swapDay - 1].cells[staff] = "出";
      }

      const nextSummary = summarize(schedule, inputs, holidays);
      const validCounts = nextSummary[staff].publicOff === targetPublicOff(staff);
      const improved = nextSummary[staff].maxRun < summary[staff].maxRun;
      if (validCounts && improved && basicDailyRulesPass(schedule)) {
        changed = true;
        break;
      }

      if (swapDay) schedule[swapDay - 1].cells[staff] = "休";
      schedule[day - 1].cells[staff] = "出";
    }

    if (!changed) return;
  }
}

function firstLongRun(schedule, staff) {
  let start = null;
  let length = 0;
  for (let index = 0; index < schedule.length; index += 1) {
    if (WORK_TYPES.has(schedule[index].cells[staff])) {
      if (start === null) start = index + 1;
      length += 1;
      if (length > MAX_CONSECUTIVE_WORK) return { start, end: index + 1 };
    } else {
      start = null;
      length = 0;
    }
  }
  return null;
}

function findPublicOffToRelease(schedule, staff, protectedDay, inputs, holidays, ruleSettings) {
  const candidates = schedule
    .filter((row) => row.day !== protectedDay && row.cells[staff] === "休" && !inputs[staff].request.has(row.day))
    .map((row) => {
      row.cells[staff] = "出";
      const maxRun = maxConsecutiveWork(schedule, staff);
      row.cells[staff] = "休";
      return { day: row.day, maxRun };
    })
    .filter((item) => item.maxRun <= MAX_CONSECUTIVE_WORK)
    .sort((a, b) => a.maxRun - b.maxRun);

  return candidates.length ? candidates[0].day : null;
}

function basicDailyRulesPass(schedule) {
  return schedule.every((row) => {
    const workers = STAFF.filter((staff) => WORK_TYPES.has(row.cells[staff])).length;
    return workers >= 4 && (WORK_TYPES.has(row.cells.A) || WORK_TYPES.has(row.cells.B));
  });
}

function publicOffCapacity(schedule, startDay) {
  let capacity = 0;
  for (let day = startDay; day <= schedule.length; day += 1) {
    const row = schedule[day - 1];
    const nonWork = STAFF.filter((staff) => !WORK_TYPES.has(row.cells[staff])).length;
    capacity += Math.max(0, 3 - nonWork);
  }
  return capacity;
}

function canSetPublicOff(schedule, day, staff, inputs, holidays, ruleSettings) {
  const row = schedule[day - 1];
  if (isStaffBWeekendFixedDay(staff, row, holidays, ruleSettings)) return false;
  if (row.cells[staff] !== "出") return false;
  if (STAFF.filter((name) => !WORK_TYPES.has(row.cells[name])).length >= 3) return false;

  if (staff === "A" || staff === "B") {
    const other = staff === "A" ? "B" : "A";
    if (!WORK_TYPES.has(row.cells[other])) return false;
  }

  if (wouldCreateNonRequestedThreeDayOff(schedule, day, staff, inputs)) return false;

  return true;
}


function wouldCreateNonRequestedThreeDayOff(schedule, day, staff, inputs) {
  const offDays = [day];

  for (let d = day - 1; d >= 1; d -= 1) {
    if (WORK_TYPES.has(schedule[d - 1].cells[staff])) break;
    offDays.push(d);
  }

  for (let d = day + 1; d <= schedule.length; d += 1) {
    if (WORK_TYPES.has(schedule[d - 1].cells[staff])) break;
    offDays.push(d);
  }

  if (offDays.length < 3) return false;
  return offDays.some((offDay) => !inputs[staff].request.has(offDay));
}

function nonRequestedLongOffRuns(schedule, staff, inputs) {
  const runs = [];
  let start = null;
  let days = [];

  for (let day = 1; day <= schedule.length; day += 1) {
    if (!WORK_TYPES.has(schedule[day - 1].cells[staff])) {
      if (start === null) start = day;
      days.push(day);
    } else {
      if (days.length >= 3 && days.some((offDay) => !inputs[staff].request.has(offDay))) {
        runs.push({ start, end: days[days.length - 1], days: [...days] });
      }
      start = null;
      days = [];
    }
  }

  if (days.length >= 3 && days.some((offDay) => !inputs[staff].request.has(offDay))) {
    runs.push({ start, end: days[days.length - 1], days: [...days] });
  }

  return runs;
}

function offScore(schedule, day, staff, offRemaining, inputs, holidays, attempt) {
  const row = schedule[day - 1];
  let score = 0;
  if (inputs[staff].request.has(day)) score += 1200;
  if (isWeekendOrHoliday(row, holidays)) score += 80 - weekendHolidayOffCount(schedule, staff, holidays) * 12;
  if (currentRunBefore(schedule, day, staff) >= 3) score += 900;
  if (wouldCreateLongRun(schedule, day, staff)) score += 180;
  score += offRemaining[staff] * 35;
  score -= STAFF.filter((name) => !WORK_TYPES.has(row.cells[name])).length * 20;
  score += seedRandom(day, staff.charCodeAt(0), attempt) * 45;
  return score;
}

function applySelectedShiftTypes(schedule, shiftOptions, attempt) {
  const notices = [];
  const assignments = [];

  if (shiftOptions.early) {
    assignments.push({ type: "早帰り", preferred: "beforeOff" });
  }
  if (shiftOptions.late) {
    assignments.push({ type: "遅番", preferred: "afterOff" });
  }

  assignments.forEach((assignment) => {
    SHIFT_ELIGIBLE_STAFF.forEach((staff) => {
      const target = findShiftAssignmentDay(schedule, staff, assignment.preferred, attempt);
      if (target) {
        schedule[target - 1].cells[staff] = assignment.type;
        if (isShiftBetweenDaysOff(schedule, target, staff)) {
          notices.push(`スタッフ${staff}の${target}日が「休・${assignment.type}・休」の並びです。他に割り当て可能な通常出勤日が少ないため、この配置になりました。`);
        }
      } else {
        notices.push(`スタッフ${staff}に${assignment.type}を割り当てられる通常出勤日がありませんでした。D・Gは対象外です。`);
      }
    });
  });

  return notices;
}

function findShiftAssignmentDay(schedule, staff, preferred, attempt) {
  const candidates = schedule
    .filter((row) => row.cells[staff] === "出")
    .map((row) => ({
      day: row.day,
      score: shiftAssignmentScore(schedule, row.day, staff, preferred, attempt),
    }))
    .sort((a, b) => b.score - a.score || a.day - b.day);

  return candidates.length ? candidates[0].day : null;
}

function shiftAssignmentScore(schedule, day, staff, preferred, attempt) {
  let score = 0;
  const previous = schedule[day - 2];
  const next = schedule[day];

  const previousIsOff = previous && !WORK_TYPES.has(previous.cells[staff]);
  const nextIsOff = next && !WORK_TYPES.has(next.cells[staff]);

  if (preferred === "beforeOff" && nextIsOff) score += 1000;
  if (preferred === "afterOff" && previousIsOff) score += 1000;
  if (previousIsOff) score += 120;
  if (nextIsOff) score += 120;
  if (previousIsOff && nextIsOff) score -= 1300;
  if (preferred === "beforeOff" && next && !WORK_TYPES.has(next.cells[staff])) score += 1000;
  if (preferred === "afterOff" && previous && !WORK_TYPES.has(previous.cells[staff])) score += 1000;
  if (previous && !WORK_TYPES.has(previous.cells[staff])) score += 120;
  if (next && !WORK_TYPES.has(next.cells[staff])) score += 120;

  score -= Math.abs(day - (schedule.length + 1) / 2) * 2;
  score += seedRandom(day, staff.charCodeAt(0), preferred.length, attempt) * 35;
  return score;
}

function isShiftBetweenDaysOff(schedule, day, staff) {
  const previous = schedule[day - 2];
  const next = schedule[day];
  return Boolean(previous && next && !WORK_TYPES.has(previous.cells[staff]) && !WORK_TYPES.has(next.cells[staff]));
}

function validateSchedule(candidate, inputs, holidays, ruleSettings) {
  const errors = [];
  const notices = [];
  const { schedule, summary } = candidate;

  STAFF.forEach((staff) => {
    const target = targetPublicOff(staff);
    if (inputs[staff].request.size > target) {
      errors.push(`スタッフ${staff}の希望公休が${inputs[staff].request.size}日あり、公休目標${target}回を超えています。原因: 希望公休の入力数`);
    }
    if (summary[staff].publicOff !== target) {
      errors.push(`スタッフ${staff}の公休が${target}回ではありません（現在${summary[staff].publicOff}回）。原因: スタッフ別の公休回数条件`);
    }

    if (summary[staff].maxRun > MAX_CONSECUTIVE_WORK) {
      errors.push(`スタッフ${staff}の連勤が最大${summary[staff].maxRun}日あります。原因: 最大連勤${MAX_CONSECUTIVE_WORK}日までの条件`);
      if (staff === STAFF_B && ruleSettings.staffBWeekendFixed) {
        errors.push(`スタッフB：土日祝出勤固定ルールにより、最大${MAX_CONSECUTIVE_WORK}連勤を超える可能性があります。修正候補：最大連勤を4日に変更する、またはスタッフB土日祝固定ルールを見直してください。`);
      }
    }

    const missed = [...inputs[staff].request].filter((day) => schedule[day - 1].cells[staff] !== "休" && !isStaffBWeekendFixedDay(staff, schedule[day - 1], holidays, ruleSettings));
    if (missed.length) errors.push(`スタッフ${staff}の希望公休が反映されていません: ${missed.join(", ")}日。原因: 希望公休固定条件`);

    nonRequestedLongOffRuns(schedule, staff, inputs).forEach((run) => {
      errors.push(`スタッフ${staff}の${run.start}日〜${run.end}日が3連休以上です。原因: 希望公休以外で3連休以上にしない条件`);
    });
  });

  schedule.forEach((row) => {
    const staffBViolation = getStaffBWeekendRestViolation(row, holidays, ruleSettings);
    if (staffBViolation) errors.push(formatStaffBWeekendRestError(row, staffBViolation.value, schedule, holidays, candidate.month));

    ["D", "G"].forEach((staff) => {
      if (row.cells[staff] === "早帰り" || row.cells[staff] === "遅番") {
        errors.push(`${row.day}日にスタッフ${staff}へ${row.cells[staff]}が入っています。原因: D・Gは早帰り・遅番の対象外条件`);
      }
    });

    const workers = STAFF.filter((staff) => WORK_TYPES.has(row.cells[staff])).length;
    if (workers < 4) {
      errors.push(`${row.day}日の出勤者が${workers}人です。原因: 毎日4人以上出勤の条件`);
    }
    if (!WORK_TYPES.has(row.cells.A) && !WORK_TYPES.has(row.cells.B)) {
      errors.push(`${row.day}日にAとBのどちらも出勤していません。原因: 毎日AかBが必ず出勤の条件`);
      errors.push(`${row.day}日にAとBが同じ日に休みです。原因: AとBを同じ日に休みにしない条件`);
    }
  });

  const weekendCounts = STAFF.map((staff) => summary[staff].weekendHolidayOff);
  const spread = Math.max(...weekendCounts) - Math.min(...weekendCounts);
  if (spread > 2) {
    notices.push(`土日祝休みの回数差が最大${spread}回あります。希望公休・有給・出張・研修が多い場合は公平性が下がります。`);
  }

  return { errors: unique(errors), notices: unique(notices) };
}


function reflectedRequestCount(schedule, staff) {
  return schedule.filter((row) => row.cells[staff] === "休").length;
}

function isStaffBWeekendFixedDay(staff, row, holidays, ruleSettings) {
  return Boolean(ruleSettings?.staffBWeekendFixed && staff === STAFF_B && isWeekendOrHoliday(row, holidays));
}

function getStaffBWeekendRestViolation(row, holidays, ruleSettings) {
  if (!isStaffBWeekendFixedDay(STAFF_B, row, holidays, ruleSettings)) return null;
  const value = row.cells[STAFF_B];
  return REST_TYPES.has(value) ? { value } : null;
}

function formatStaffBWeekendRestError(row, value, schedule, holidays, month) {
  const date = month ? `${month}/${row.day}` : `${row.day}日`;
  const dayType = dayTypeLabel(row, holidays);
  const alternatives = weekdayPublicOffCandidates(schedule, row.day, holidays);
  const alternativeText = alternatives.length
    ? `スタッフBの代わりの公休候補は${alternatives.join("、")}です`
    : "スタッフBの代わりの平日公休候補が不足しています";
  return `${date}（${WEEKDAYS[row.weekday]}）：スタッフB土日祝休み禁止チェック。対象スタッフ: スタッフB、現在の勤務区分: 「${value}」。違反内容: スタッフBは${dayType}に「休」「有」を入れられません。修正候補: スタッフBを「出」に変更してください。${alternativeText}。`;
}

function weekdayPublicOffCandidates(schedule, excludeDay, holidays) {
  return schedule
    .filter((row) => row.day !== excludeDay && !isWeekendOrHoliday(row, holidays) && row.cells[STAFF_B] === "出")
    .slice(0, 3)
    .map((row) => `${row.day}日`);
}

function dayTypeLabel(row, holidays) {
  if (holidays.has(row.day)) return "祝日";
  if (row.weekday === 6) return "土曜日";
  if (row.weekday === 0) return "日曜日";
  return "平日";
}

function findStaffBBlockedInputWarnings(year, month, inputs, holidays, ruleSettings) {
  if (!ruleSettings.staffBWeekendFixed) return [];
  const warnings = [];
  [
    { kind: "request", label: "希望休", blockedLabel: "未反映希望休" },
    { kind: "paid", label: "有給", blockedLabel: "未反映有給" },
  ].forEach(({ kind, label, blockedLabel }) => {
    [...inputs[STAFF_B][kind]].sort((a, b) => a - b).forEach((day) => {
      const row = { day, weekday: new Date(year, month - 1, day).getDay(), cells: {} };
      if (!isWeekendOrHoliday(row, holidays)) return;
      warnings.push(`${blockedLabel}: スタッフBの${month}/${day}は${dayTypeLabel(row, holidays)}のため、${label}を反映できません。勝手に削除せず未反映として残しています。`);
    });
  });
  return warnings;
}

function renderEditableCell(row, staff, result) {
  const value = row.cells[staff];
  const violation = staff === STAFF_B && getStaffBWeekendRestViolation(row, result.holidays, result.ruleSettings);
  const classes = [cellClass(value), violation ? "rule-violation" : ""].filter(Boolean).join(" ");
  const options = SHIFT_VALUES.map((type) => `<option value="${type}" ${type === value ? "selected" : ""}>${type}</option>`).join("");
  return `<td class="${classes}"><select class="shift-select" data-day="${row.day}" data-staff="${staff}" aria-label="${row.day}日 スタッフ${staff}">${options}</select></td>`;
}

function handleManualEdit(event) {
  const select = event.target.closest(".shift-select");
  if (!select || !currentResult) return;
  const day = Number(select.dataset.day);
  const staff = select.dataset.staff;
  currentResult.schedule[day - 1].cells[staff] = select.value;
  currentResult.summary = summarize(currentResult.schedule, currentResult.inputs, currentResult.holidays);
  const validation = validateSchedule(
    { schedule: currentResult.schedule, summary: currentResult.summary, month: currentResult.month },
    currentResult.inputs,
    currentResult.holidays,
    currentResult.ruleSettings,
  );
  currentResult.errors = unique(validation.errors);
  currentResult.notices = unique(validation.notices);
  renderResult(currentResult);
}

function findInputConflicts(inputs) {
  const warnings = [];
  STAFF.forEach((staff) => {
    const requestAndPaid = intersection(inputs[staff].request, inputs[staff].paid);
    const requestAndTrip = intersection(inputs[staff].request, inputs[staff].trip);
    const requestAndTraining = intersection(inputs[staff].request, inputs[staff].training);
    const paidAndTrip = intersection(inputs[staff].paid, inputs[staff].trip);
    const paidAndTraining = intersection(inputs[staff].paid, inputs[staff].training);
    const tripAndTraining = intersection(inputs[staff].trip, inputs[staff].training);
    if (requestAndPaid.length) warnings.push(`スタッフ${staff}は希望公休と有給が同じ日に入力されています: ${requestAndPaid.join(", ")}日。希望公休を優先します。`);
    if (requestAndTrip.length) warnings.push(`スタッフ${staff}は希望公休と出張が同じ日に入力されています: ${requestAndTrip.join(", ")}日。希望公休を優先します。`);
    if (requestAndTraining.length) warnings.push(`スタッフ${staff}は希望公休と研修が同じ日に入力されています: ${requestAndTraining.join(", ")}日。希望公休を優先します。`);
    if (paidAndTrip.length) warnings.push(`スタッフ${staff}は有給と出張が同じ日に入力されています: ${paidAndTrip.join(", ")}日。出張を優先します。`);
    if (paidAndTraining.length) warnings.push(`スタッフ${staff}は有給と研修が同じ日に入力されています: ${paidAndTraining.join(", ")}日。研修を優先します。`);
    if (tripAndTraining.length) warnings.push(`スタッフ${staff}は出張と研修が同じ日に入力されています: ${tripAndTraining.join(", ")}日。出張を優先します。`);
  });
  return warnings;
}

function scoreCandidate(validation, candidate, inputs, holidays, ruleSettings) {
  let score = validation.errors.length * 10000 + (validation.notices.length + (candidate.shiftNotices?.length || 0)) * 90;
  score += shiftPreferencePenalty(candidate.schedule) * 25;
  STAFF.forEach((staff) => {
    score += Math.abs(candidate.summary[staff].publicOff - targetPublicOff(staff)) * 5000;
    score += Math.max(0, candidate.summary[staff].maxRun - MAX_CONSECUTIVE_WORK) * 2200;
    score += nonRequestedLongOffRuns(candidate.schedule, staff, inputs).length * 2400;
    const missed = [...inputs[staff].request].filter((day) => candidate.schedule[day - 1].cells[staff] !== "休" && !isStaffBWeekendFixedDay(staff, candidate.schedule[day - 1], holidays, ruleSettings)).length;
    score += missed * 280;
  });
  const weekendCounts = STAFF.map((staff) => candidate.summary[staff].weekendHolidayOff);
  score += (Math.max(...weekendCounts) - Math.min(...weekendCounts)) * 55;
  return score;
}

function shiftPreferencePenalty(schedule) {
  let penalty = 0;
  schedule.forEach((row) => {
    SHIFT_ELIGIBLE_STAFF.forEach((staff) => {
      if (row.cells[staff] === "早帰り") {
        const next = schedule[row.day];
        if (!next || WORK_TYPES.has(next.cells[staff])) penalty += 1;
        if (isShiftBetweenDaysOff(schedule, row.day, staff)) penalty += 8;
      }
      if (row.cells[staff] === "遅番") {
        const previous = schedule[row.day - 2];
        if (!previous || WORK_TYPES.has(previous.cells[staff])) penalty += 1;
        if (isShiftBetweenDaysOff(schedule, row.day, staff)) penalty += 8;
      }
    });
  });
  return penalty;
}

function summarize(schedule, inputs, holidays) {
  const summary = {};
  STAFF.forEach((staff) => {
    summary[staff] = { publicOff: 0, paid: 0, weekendHolidayOff: 0, weekendHolidayWork: 0, weekendHolidayRestViolations: 0, weekdayPublicOff: 0, weekdayPaid: 0, trip: 0, training: 0, early: 0, late: 0, maxRun: 0 };
  });

  schedule.forEach((row) => {
    STAFF.forEach((staff) => {
      const value = row.cells[staff];
      if (value === "休") summary[staff].publicOff += 1;
      if (value === "有") summary[staff].paid += 1;
      if (value === "出張") summary[staff].trip += 1;
      if (value === "研修") summary[staff].training += 1;
      if (value === "早帰り") summary[staff].early += 1;
      if (value === "遅番") summary[staff].late += 1;
      if ((value === "休" || value === "有") && isWeekendOrHoliday(row, holidays)) {
        summary[staff].weekendHolidayOff += 1;
      }
      if (WORK_TYPES.has(value) && isWeekendOrHoliday(row, holidays)) {
        summary[staff].weekendHolidayWork += 1;
      }
      if (staff === STAFF_B && (value === "休" || value === "有") && isWeekendOrHoliday(row, holidays)) {
        summary[staff].weekendHolidayRestViolations += 1;
      }
      if (value === "休" && !isWeekendOrHoliday(row, holidays)) {
        summary[staff].weekdayPublicOff += 1;
      }
      if (value === "有" && !isWeekendOrHoliday(row, holidays)) {
        summary[staff].weekdayPaid += 1;
      }
    });
  });

  STAFF.forEach((staff) => {
    summary[staff].maxRun = maxConsecutiveWork(schedule, staff);
  });
  return summary;
}

function renderResult(result) {
  els.export.disabled = false;
  renderSummary(result);
  renderMessages(result);
  renderTable(result);
}

function renderSummary(result) {
  els.summary.innerHTML = STAFF.map((staff) => {
    const item = result.summary[staff];
    return `
      <div class="summary-card">
        <strong>${staff}</strong>
        <span>公休: ${item.publicOff} / ${targetPublicOff(staff)}</span>
        <span>有給: ${item.paid}</span>
        <span>土日祝休: ${item.weekendHolidayOff}</span>
        <span>最大連勤: ${item.maxRun}</span>
        ${staff === STAFF_B ? `<span>土日祝出勤: ${item.weekendHolidayWork}</span><span>土日祝休み違反: ${item.weekendHolidayRestViolations}</span><span>平日公休: ${item.weekdayPublicOff}</span><span>平日有給: ${item.weekdayPaid}</span>` : ""}
        <span>出張: ${item.trip} / 研修: ${item.training}</span>
        <span>早帰り: ${item.early} / 遅番: ${item.late}</span>
      </div>
    `;
  }).join("");
}

function renderMessages(result) {
  const blocks = [];
  if (!result.errors.length) {
    blocks.push(`<div class="message ok"><h3>作成できました</h3><p>必須条件を満たす勤務表を作成しました。未反映の希望がある場合は補足欄を確認してください。</p></div>`);
  } else {
    blocks.push(messageList("エラー一覧", result.errors, "error"));
  }
  if (result.notices.length) {
    blocks.push(messageList("補足", result.notices, "warn"));
  }
  els.messages.innerHTML = blocks.join("");
}

function messageList(title, items, type) {
  return `
    <div class="message ${type}">
      <h3>${title}</h3>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  `;
}

function renderTable(result) {
  const header = `
    <thead>
      <tr>
        <th>日付</th>
        ${STAFF.map((staff) => `<th>${staff}</th>`).join("")}
        <th>出勤者</th>
      </tr>
    </thead>
  `;
  const body = result.schedule.map((row) => {
    const dateLabel = `${row.day}日`;
    const dayClass = isWeekendOrHoliday(row, result.holidays) ? "weekend-holiday" : "";
    const workers = STAFF.filter((staff) => WORK_TYPES.has(row.cells[staff])).length;
    return `
      <tr>
        <td class="${dayClass}"><span class="day-number">${dateLabel}</span><span class="weekday">${WEEKDAYS[row.weekday]}</span></td>
        ${STAFF.map((staff) => renderEditableCell(row, staff, result)).join("")}
        <td class="count-cell">${workers}</td>
      </tr>
    `;
  }).join("");
  els.table.innerHTML = `${header}<tbody>${body}</tbody>`;
}

function cellClass(value) {
  if (value === "休") return "day-off";
  if (value === "有") return "paid";
  if (value === "出張") return "trip";
  if (value === "研修") return "training";
  if (value === "早帰り") return "early-shift";
  if (value === "遅番") return "late-shift";
  return "";
}

function exportExcel() {
  if (!currentResult) return;
  const title = `${currentResult.year}年${currentResult.month}月 勤務表`;
  const rows = [
    `<tr><th>日付</th>${STAFF.map((staff) => `<th>${staff}</th>`).join("")}<th>出勤者</th></tr>`,
    ...currentResult.schedule.map((row) => {
      const workers = STAFF.filter((staff) => WORK_TYPES.has(row.cells[staff])).length;
      return `<tr><td>${row.day}日(${WEEKDAYS[row.weekday]})</td>${STAFF.map((staff) => `<td>${row.cells[staff]}</td>`).join("")}<td>${workers}</td></tr>`;
    }),
    `<tr></tr>`,
    `<tr><th>スタッフ</th><th>公休</th><th>有給</th><th>土日祝休</th><th>最大連勤</th><th>出張</th><th>研修</th><th>早帰り</th><th>遅番</th></tr>`,
    ...STAFF.map((staff) => {
      const item = currentResult.summary[staff];
      return `<tr><td>${staff}</td><td>${item.publicOff}</td><td>${item.paid}</td><td>${item.weekendHolidayOff}</td><td>${item.maxRun}</td><td>${item.trip}</td><td>${item.training}</td><td>${item.early}</td><td>${item.late}</td></tr>`;
    }),
  ];

  const html = `
    <html><head><meta charset="utf-8"></head>
    <body><h1>${title}</h1><table border="1">${rows.join("")}</table></body></html>
  `;
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `勤務表_${currentResult.year}_${String(currentResult.month).padStart(2, "0")}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function clearInputs() {
  document.querySelectorAll("[data-kind][data-staff]").forEach((node) => {
    node.value = "";
  });
  els.earlyShift.checked = false;
  els.lateShift.checked = false;
  if (els.staffBWeekendFixed) els.staffBWeekendFixed.checked = true;
  currentResult = null;
  els.export.disabled = true;
  renderEmptyState();
}

function fillSample() {
  clearInputs();
  const sample = {
    A: { request: "2, 9, 18", paid: "23", trip: "6", training: "" },
    B: { request: "3, 10, 24", paid: "", trip: "", training: "14" },
    C: { request: "4, 11, 22", paid: "16", trip: "", training: "" },
    D: { request: "5, 12, 26", paid: "", trip: "19", training: "" },
    E: { request: "1, 15, 27", paid: "", trip: "", training: "8" },
    F: { request: "7, 17, 28", paid: "21", trip: "", training: "" },
    G: { request: "13, 20, 29", paid: "", trip: "25", training: "" },
  };
  Object.entries(sample).forEach(([staff, values]) => {
    Object.entries(values).forEach(([kind, value]) => {
      document.querySelector(`[data-staff="${staff}"][data-kind="${kind}"]`).value = value;
    });
  });
}

function getJapaneseHolidaySet(year, month) {
  const all = new Set();
  const add = (m, d) => all.add(`${m}-${d}`);

  add(1, 1);
  add(1, nthWeekday(year, 1, 1, 2));
  add(2, 11);
  add(2, 23);
  add(3, springEquinox(year));
  add(4, 29);
  add(5, 3);
  add(5, 4);
  add(5, 5);
  add(7, nthWeekday(year, 7, 1, 3));
  add(8, 11);
  add(9, nthWeekday(year, 9, 1, 3));
  add(9, autumnEquinox(year));
  add(10, nthWeekday(year, 10, 1, 2));
  add(11, 3);
  add(11, 23);

  if (year === 2020) {
    all.delete(`7-${nthWeekday(year, 7, 1, 3)}`);
    all.delete("10-12");
    add(7, 23);
    add(7, 24);
    add(8, 10);
  }
  if (year === 2021) {
    all.delete(`7-${nthWeekday(year, 7, 1, 3)}`);
    all.delete("8-11");
    all.delete("10-11");
    add(7, 22);
    add(7, 23);
    add(8, 8);
  }

  applySubstituteHolidays(year, all);
  applyCitizenHolidays(year, all);

  const dates = new Set();
  all.forEach((key) => {
    const [m, d] = key.split("-").map(Number);
    if (m === month) dates.add(d);
  });
  return dates;
}

function applySubstituteHolidays(year, all) {
  [...all].sort(byMonthDay).forEach((key) => {
    const [month, day] = key.split("-").map(Number);
    if (new Date(year, month - 1, day).getDay() !== 0) return;
    const next = new Date(year, month - 1, day + 1);
    while (all.has(`${next.getMonth() + 1}-${next.getDate()}`)) {
      next.setDate(next.getDate() + 1);
    }
    all.add(`${next.getMonth() + 1}-${next.getDate()}`);
  });
}

function applyCitizenHolidays(year, all) {
  for (let m = 1; m <= 12; m += 1) {
    const days = new Date(year, m, 0).getDate();
    for (let d = 2; d < days; d += 1) {
      const prev = `${m}-${d - 1}`;
      const cur = `${m}-${d}`;
      const next = `${m}-${d + 1}`;
      if (!all.has(cur) && all.has(prev) && all.has(next)) all.add(cur);
    }
  }
}

function nthWeekday(year, month, weekday, nth) {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1) break;
    if (date.getDay() === weekday) count += 1;
    if (count === nth) return day;
  }
  return 1;
}

function springEquinox(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnEquinox(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function isWeekendOrHoliday(row, holidays) {
  return row.weekday === 0 || row.weekday === 6 || holidays.has(row.day);
}

function maxConsecutiveWork(schedule, staff) {
  let max = 0;
  let run = 0;
  schedule.forEach((row) => {
    if (WORK_TYPES.has(row.cells[staff])) {
      run += 1;
      max = Math.max(max, run);
    } else {
      run = 0;
    }
  });
  return max;
}

function currentRunBefore(schedule, day, staff) {
  let run = 0;
  for (let d = day - 1; d >= 1; d -= 1) {
    if (!WORK_TYPES.has(schedule[d - 1].cells[staff])) break;
    run += 1;
  }
  return run;
}

function wouldCreateLongRun(schedule, day, staff) {
  let before = 0;
  let after = 0;
  for (let d = day - 1; d >= 1; d -= 1) {
    if (!WORK_TYPES.has(schedule[d - 1].cells[staff])) break;
    before += 1;
  }
  for (let d = day + 1; d <= schedule.length; d += 1) {
    if (!WORK_TYPES.has(schedule[d - 1].cells[staff])) break;
    after += 1;
  }
  return before + after >= 3;
}

function weekendHolidayOffCount(schedule, staff, holidays) {
  return schedule.filter((row) => isWeekendOrHoliday(row, holidays) && (row.cells[staff] === "休" || row.cells[staff] === "有")).length;
}

function intersection(a, b) {
  return [...a].filter((value) => b.has(value));
}

function unique(items) {
  return [...new Set(items)];
}

function sum(items) {
  return items.reduce((total, item) => total + item, 0);
}

function seedRandom(...nums) {
  let x = nums.reduce((acc, num) => acc + num * 374761393, 668265263);
  x = (x ^ (x >> 13)) * 1274126177;
  return ((x ^ (x >> 16)) >>> 0) / 4294967295;
}

function byMonthDay(a, b) {
  const [am, ad] = a.split("-").map(Number);
  const [bm, bd] = b.split("-").map(Number);
  return am === bm ? ad - bd : am - bm;
}

function kindLabel(kind) {
  return { request: "希望公休", paid: "有給", trip: "出張", training: "研修" }[kind] || kind;
}

function targetPublicOff(staff) {
  return OFF_TARGETS[staff] || 10;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}
