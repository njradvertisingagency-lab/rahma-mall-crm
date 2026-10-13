'use strict';
(function () {
  const { el, api, toast, badges } = App;

  // ── أسماء مطابقة للسيستم ──
  const STATUS_AR = {
    NEW: 'جديد', NO_ANSWER: 'لا يوجد رد', FOLLOW_UP: 'متابعة',
    INTERESTED: 'مهتم', NOT_INTERESTED: 'غير مهتم', SOLD: 'تم البيع',
    CUSTOMER_WAITING: 'عميل منتظر', CLOSED: 'مغلق',
  };
  const STATUS_COLORS = {
    NEW: '#3498db', NO_ANSWER: '#95a5a6', FOLLOW_UP: '#e67e22',
    INTERESTED: '#27ae60', NOT_INTERESTED: '#7f8c8d', SOLD: '#2ecc71',
    CUSTOMER_WAITING: '#f39c12', CLOSED: '#27ae60',
  };
  const STATUS_EMOJI = {
    NEW: '🆕', NO_ANSWER: '📵', FOLLOW_UP: '🔁', INTERESTED: '⭐',
    NOT_INTERESTED: '❌', SOLD: '💰', CUSTOMER_WAITING: '⏳', CLOSED: '✅',
  };
  // ── أسماء نتائج المكالمات — مطابقة للسيستم بالظبط ──
  const CALL_OUTCOME_AR = {
    ANSWERED: 'تم الرد', NO_ANSWER: 'لا يوجد رد', BUSY: 'مشغول',
    WRONG_NUMBER: 'رقم خاطئ', SWITCHED_OFF: 'مغلق', REJECTED: 'تم الرفض',
  };
  const CALL_OUTCOME_EMOJI = {
    ANSWERED: '✅', NO_ANSWER: '📵', BUSY: '🔴',
    WRONG_NUMBER: '❌', SWITCHED_OFF: '📴', REJECTED: '🚫',
  };
  const CALL_OUTCOME_COLORS = {
    ANSWERED: '#27ae60', NO_ANSWER: '#e67e22', BUSY: '#e74c3c',
    WRONG_NUMBER: '#95a5a6', SWITCHED_OFF: '#7f8c8d', REJECTED: '#c0392b',
  };

  App.route('/daily-report', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📊 تقرير اليوم']),
      el('div', { class: 'page-actions' }, [el('button', { class: 'btn btn-outline', onclick: () => load() }, ['🔄 تحديث'])]),
    ]));

    const reportWrap = el('div');
    container.appendChild(reportWrap);

    async function load() {
      reportWrap.innerHTML = '';
      let data;
      try {
        data = await api('/daily-report');
      } catch (e) {
        reportWrap.appendChild(el('div', { class: 'empty-state' }, [e.message]));
        return;
      }

      // ── الصف الأول: الأرقام الأساسية ──
      const topGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px' });
      topGrid.appendChild(statCard('📱', 'استلمت', data.totalReceived, 'رقم', '#3498db'));
      topGrid.appendChild(statCard('✅', 'باقي معايا', data.remaining, 'رقم', '#27ae60'));
      topGrid.appendChild(statCard('🔄', 'اتسحب', data.reclaimedCount, 'رقم', '#e74c3c'));
      topGrid.appendChild(statCard('⏰', 'الحضور', data.checkinTime, '', '#9b59b6'));
      reportWrap.appendChild(topGrid);

      // ── الصف التاني: النشاط ──
      const actGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px' });
      actGrid.appendChild(statCard('📞', 'مكالمات', data.callsCount, 'محاولة', '#e67e22'));
      actGrid.appendChild(statCard('✍️', 'ملاحظات', data.notesCustomers, 'عميل', '#2980b9'));
      actGrid.appendChild(statCard('💬', 'واتساب', data.whatsappCount, 'عميل', '#25d366'));
      reportWrap.appendChild(actGrid);

      // ── تفاصيل المكالمات (chips) ──
      const callOutcomeEntries = Object.entries(data.callOutcomeBreakdown || {});
      if (callOutcomeEntries.length > 0) {
        const callCard = el('div', { style: 'background:var(--surface-2);border-radius:16px;padding:16px;margin-bottom:14px;border:1px solid var(--border);box-shadow:0 1px 4px rgba(0,0,0,.08)' });
        callCard.appendChild(el('div', { style: 'font-weight:900;margin-bottom:12px;font-size:15px;display:flex;align-items:center;gap:6px' }, ['📞 تفاصيل المكالمات']));
        const chipGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px' });
        callOutcomeEntries.forEach(([k, n]) => {
          chipGrid.appendChild(el('div', {
            style: `background:${CALL_OUTCOME_COLORS[k] || '#555'};color:#fff;padding:10px 8px;border-radius:14px;font-weight:800;font-size:13px;text-align:center;line-height:1.4`,
          }, [el('div', { style: 'font-size:20px;font-weight:900' }, [String(n)]), el('div', { style: 'font-size:11px;opacity:.9' }, [CALL_OUTCOME_AR[k] || k])]));
        });
        callCard.appendChild(chipGrid);
        reportWrap.appendChild(callCard);
      }

      // ── توزيع الحالات (chips) ──
      const statusEntries = Object.entries(data.statusBreakdown || {});
      if (statusEntries.length > 0) {
        const statusCard = el('div', { style: 'background:var(--surface-2);border-radius:16px;padding:16px;margin-bottom:14px;border:1px solid var(--border);box-shadow:0 1px 4px rgba(0,0,0,.08)' });
        statusCard.appendChild(el('div', { style: 'font-weight:900;margin-bottom:12px;font-size:15px;display:flex;align-items:center;gap:6px' }, ['📈 توزيع الحالات']));
        const sGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px' });
        statusEntries.forEach(([st, n]) => {
          sGrid.appendChild(el('div', {
            style: `background:${STATUS_COLORS[st] || '#555'};color:#fff;padding:10px 8px;border-radius:14px;font-weight:800;font-size:13px;text-align:center;line-height:1.4`,
          }, [el('div', { style: 'font-size:20px;font-weight:900' }, [String(n)]), el('div', { style: 'font-size:11px;opacity:.9' }, [STATUS_AR[st] || st])]));
        });
        statusCard.appendChild(sGrid);
        reportWrap.appendChild(statusCard);
      }

      // ══════════════════════════════════════════════════════════════
      //  زرار إنشاء التقرير + إرسال — بعد ٥:٤٥ بس
      // ══════════════════════════════════════════════════════════════
      const reportActionsWrap = el('div', { style: 'margin-top:14px' });

      if (!data.canSend) {
        // قبل ٥:٤٥
        reportActionsWrap.appendChild(el('div', {
          style: 'text-align:center;padding:18px;background:var(--surface-2);border-radius:16px;color:var(--muted);font-size:14px;font-weight:700;border:1px solid var(--border)',
        }, [`🔒 إنشاء التقرير والإرسال هيفتح الساعة ${data.reportUnlockText || '٥:٤٥ م'}`]));
      } else {
        // بعد ٥:٤٥ — زر إنشاء التقرير
        const reportPreview = el('div', { style: 'display:none' });
        let generatedText = '';

        const generateBtn = el('button', {
          style: 'display:flex;align-items:center;justify-content:center;gap:10px;font-size:16px;font-weight:900;padding:16px 30px;background:linear-gradient(135deg,#3498db,#2980b9);color:#fff;border-radius:16px;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(52,152,219,.3);width:100%;margin-bottom:12px',
          onclick: () => {
            // توليد نص التقرير من البيانات المحملة
            generatedText = buildReportText(data);
            // عرض البريفيو
            reportPreview.innerHTML = '';
            reportPreview.style.display = '';

            const previewCard = el('div', { style: 'background:var(--surface-2);border-radius:16px;padding:16px;margin-bottom:14px;border:1px solid var(--border);box-shadow:0 1px 4px rgba(0,0,0,.08)' });
            previewCard.appendChild(el('div', { style: 'font-weight:900;margin-bottom:10px;font-size:15px;display:flex;align-items:center;gap:6px' }, ['📝 تقريرك جاهز']));
            previewCard.appendChild(el('pre', { style: 'white-space:pre-wrap;font-family:inherit;margin:0;line-height:1.9;background:var(--surface);padding:14px;border-radius:12px;font-size:13.5px;color:var(--text);border:1px solid var(--border)' }, [generatedText]));
            reportPreview.appendChild(previewCard);

            // زر الإرسال للتيم ليدر
            const sendBtn = el('a', {
              href: `https://wa.me/${data.teamLeaderIntl}?text=${encodeURIComponent(generatedText)}`,
              target: '_blank', rel: 'noopener',
              style: 'display:flex;align-items:center;justify-content:center;gap:10px;font-size:18px;font-weight:900;padding:18px 30px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;border-radius:16px;text-decoration:none;box-shadow:0 4px 16px rgba(37,211,102,.3);width:100%',
            }, ['📩 إرسال التقرير للتيم ليدر']);
            reportPreview.appendChild(sendBtn);

            generateBtn.style.display = 'none';
            toast('تم إنشاء التقرير ✅', 'success');
          },
        }, ['📋 إنشاء تقرير اليوم']);

        reportActionsWrap.appendChild(generateBtn);
        reportActionsWrap.appendChild(reportPreview);
      }

      reportWrap.appendChild(reportActionsWrap);
    }

    // ── بناء نص التقرير من البيانات — client-side ──
    function buildReportText(d) {
      const dateParts = d.date.split('-');
      const dateAr = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;

      const callOutcomeLines = Object.entries(d.callOutcomeBreakdown || {})
        .map(([k, v]) => `  ${CALL_OUTCOME_EMOJI[k] || '•'} ${CALL_OUTCOME_AR[k] || k}: *${v}*`)
        .join('\n');

      const statusLines = Object.entries(d.statusBreakdown || {})
        .map(([k, v]) => `  ${STATUS_EMOJI[k] || '•'} ${STATUS_AR[k] || k}: *${v}*`)
        .join('\n');

      return [
        `━━━━━━━━━━━━━━━━━━━`,
        `📊 *تقرير يومي — ${dateAr}*`,
        `👤 *${d.employeeName}*`,
        `⏰ الحضور: ${d.checkinTime}`,
        `━━━━━━━━━━━━━━━━━━━`,
        '',
        `📱 *الأرقام*`,
        `  استلمت: *${d.totalReceived}* رقم`,
        `  اتسحب: *${d.reclaimedCount}* رقم`,
        `  باقي معايا: *${d.remaining}* رقم`,
        '',
        `📞 *المكالمات: ${d.callsCount} محاولة*`,
        callOutcomeLines || '  لا توجد مكالمات',
        '',
        `✍️ *الملاحظات*`,
        `  كتبت على: *${d.notesCustomers}* عميل (${d.notesTotal} ملاحظة)`,
        '',
        `💬 *واتساب:* ${d.whatsappCount} عميل`,
        '',
        `📈 *توزيع الحالات:*`,
        statusLines || '  لا توجد حالات',
        '',
        `━━━━━━━━━━━━━━━━━━━`,
        `🏢 *رحمة مول — CRM*`,
      ].filter(Boolean).join('\n');
    }

    function statCard(icon, label, value, unit, color) {
      return el('div', {
        style: 'background:var(--surface-2);border-radius:14px;padding:14px 10px;text-align:center;border:1px solid var(--border);box-shadow:0 1px 4px rgba(0,0,0,.06)',
      }, [
        el('div', { style: 'font-size:22px;margin-bottom:2px' }, [icon]),
        el('div', { style: `font-size:26px;font-weight:900;margin:2px 0;${color ? 'color:' + color : ''}` }, [String(value)]),
        el('div', { style: 'font-weight:700;font-size:12.5px;color:var(--text)' }, [label]),
        unit ? el('div', { style: 'font-size:11px;color:var(--muted);margin-top:2px' }, [unit]) : null,
      ].filter(Boolean));
    }

    await load();
    return container;
  });
})();
