'use strict';
(function () {
    const { el, api, toast, badges, fmt } = App;
    // الحالات القابلة للاختيار يدويًا من القائمة — 5 حالات (طلب صاحب الشركة):
   // جديد (تلقائية) ← لا يستجيب ← متابعة ← تم الاتفاق ← مغلق (عبر زر تمت الصفقة).
   const SELECTABLE_STATUSES = ['NO_ANSWER', 'FOLLOW_UP', 'AGREED'];
    const STATUS_LABELS = App.labels.status;
    const SLA_LEVEL_LABELS = { OK: 'ضمن الموعد', WARNING: 'اقترب الموعد', BREACHED: 'تم تجاوز الموعد' };
    const PAYMENT_METHOD_LABELS = { CASH: 'نقدًا', CARD: 'بطاقة', INSTALLMENT: 'تقسيط', OTHER: 'أخرى' };
    const CLOSED_REASONS = [
          ['Purchased', 'تم الشراء'],
          ['Not Interested', 'غير مهتم'],
          ['Wrong Number', 'رقم خاطئ'],
          ['Already Purchased', 'اشترى مسبقًا'],
          ['Price', 'السعر'],
          ['Unavailable Product', 'المنتج غير متوفر'],
          ['Other', 'أخرى'],
        ];
    const CALL_OUTCOMES = [
          ['ANSWERED', 'تم الرد'],
          ['NO_ANSWER', 'لا يوجد رد'],
          ['BUSY', 'مشغول'],
          ['WRONG_NUMBER', 'رقم خاطئ'],
          ['SWITCHED_OFF', 'مغلق'],
          ['REJECTED', 'تم الرفض'],
        ];
    const CALL_OUTCOME_LABELS = Object.fromEntries(CALL_OUTCOMES);
    const CALL_OUTCOME_COLORS = { ANSWERED:'#27ae60', NO_ANSWER:'#e67e22', BUSY:'#e74c3c', WRONG_NUMBER:'#95a5a6', SWITCHED_OFF:'#7f8c8d', REJECTED:'#c0392b' };
    const FOLLOWUP_STATUS_LABELS = { UPCOMING: 'قادمة', DUE: 'مستحقة', OVERDUE: 'متأخرة', COMPLETED: 'مكتملة', CANCELLED: 'ملغاة' };

   function modal(title, bodyNode, footerNodes) {
         const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
         const m = el('div', { class: 'modal' }, [
                 el('div', { class: 'modal-header' }, [el('div', { class: 'modal-title' }, [title]), el('button', { class: 'modal-close', onclick: () => close() }, ['✕'])]),
                 el('div', { class: 'modal-body' }, [bodyNode]),
                 el('div', { class: 'modal-footer' }, footerNodes || []),
               ]);
         backdrop.appendChild(m);
         document.body.appendChild(backdrop);
         function close() { backdrop.remove(); }
         return { close, el: backdrop };
   }

   App.route('/customers/:id', async ({ id }) => {
         const user = App.state.user;
         const container = el('div');
         let data;
         async function load() {
                 data = await api('/customers/' + id);
         }
         await load();

                 async function toggleVip() {
                         try {
                                   await api('/customers/' + id + '/vip', { method: 'POST', body: { isVip: !data.customer.isVip } });
                                   toast(data.customer.isVip ? 'تم إلغاء تمييز VIP' : '👑 تم تمييز العميل كـ VIP', 'success');
                                   await load();
                                   render();
                         } catch (e) { toast(e.message, 'error'); }
                 }
         function render() {
                 container.innerHTML = '';
                 const c = data.customer;
                 container.appendChild(el('div', { class: 'page-header' }, [
                           el('div', {}, [
                                       el('div', { class: 'page-title' }, [c.isVip ? '👑 ' : '', c.id, ' ', badges.status(c.status), ' ', badges.dealStatus(c.dealStatus)]),
                                       el('div', { class: 'muted mono' }, [c.phone]),
                                     ]),
                           el('div', { class: 'page-actions' }, [
                                       user.role === 'team_leader' ? el('button', { class: 'btn btn-outline', onclick: toggleVip }, [c.isVip ? '👑 إلغاء VIP' : '👑 تمييز VIP']) : null,
                                       el('button', { class: 'btn btn-outline', onclick: () => App.navigate('#/customers') }, ['← رجوع']),
                                     ]),
                         ]));

           container.appendChild(renderCustomer360Strip(c));

           const grid = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:18px' }, []);
                 if (window.innerWidth < 880) grid.style.gridTemplateColumns = '1fr';

           const left = el('div', { style: 'min-width:0' });
                 left.appendChild(renderInfoCard(c));
                 left.appendChild(el('div', { class: 'section-title' }, ['اهتمام بالمنتجات']));
                 left.appendChild(renderProducts());
                 left.appendChild(el('div', { class: 'section-title' }, ['محاولات الاتصال']));
                 left.appendChild(renderCallAttempts());
                 left.appendChild(el('div', { class: 'section-title' }, ['زيارات الفرع والمشتريات']));
                 left.appendChild(renderSalesSection());
                 left.appendChild(el('div', { class: 'section-title' }, ['المتابعات']));
                 left.appendChild(renderFollowups());
                 left.appendChild(el('div', { class: 'section-title' }, ['سجل النشاط']));
                 left.appendChild(renderTimeline());

           const right = el('div', { style: 'min-width:0' });
                 right.appendChild(renderActionsCard(c));

           grid.appendChild(left);
                 grid.appendChild(right);
                 container.appendChild(grid);

           updateNoteGuard();
         }

                 // ---------------------------------------------------------------------
                 // ملاحظة إلزامية — لو الموظف فتح هذا العميل ولم يكتب ملاحظة بعد، يُمنع
                 // من مغادرة الصفحة (زر رجوع، أي رابط، رجوع المتصفح) لحد ما يكتبها.
                 // مقصورة على الموظف صاحب العميل — قائد الفريق يتصفح بحرية دائمًا.
                 // ---------------------------------------------------------------------
                 // الـ mandatory note popup اتشال — مفيش إجبار على كتابة ملاحظة قبل المتابعة.
                 function updateNoteGuard() {
                         App.clearNoteGuard();
                 }

                 // --- شريط 360: تقييم العميل (قابل للتفسير)، حالة الموعد، من رآه ---
                 function renderCustomer360Strip(c) {
                         const card = el('div', { class: 'card card-pad mb-16', style: 'display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start' });

           const scoreBox = el('div', {}, [
                     el('div', { class: 'faint' }, ['تقييم العميل']),
                     el('div', { style: 'font-size:24px;font-weight:800' }, [String(c.leadScore)]),
                   ]);
                         const reasonsBtn = el('button', { class: 'link-btn', style: 'font-size:11px' }, ['السبب؟ ▾']);
                         const reasonsBox = el('div', { class: 'faint', style: 'display:none;font-size:11px;max-width:260px' },
                                                       c.leadScoreReasons.length === 0 ? ['لا توجد إشارات تقييم بعد.'] :
                                                       c.leadScoreReasons.map((r) => el('div', {}, [`${r.points > 0 ? '+' : ''}${r.points} — ${r.label}`])));
                         reasonsBtn.onclick = () => { reasonsBox.style.display = reasonsBox.style.display === 'none' ? 'block' : 'none'; };
                         scoreBox.appendChild(reasonsBtn);
                         scoreBox.appendChild(reasonsBox);
                         card.appendChild(scoreBox);

           const slaBox = el('div', {}, [el('div', { class: 'faint' }, ['حالة الموعد']), badges.sla(c.sla?.worst)]);
                         if (c.sla) {
                                   const details = [];
                                   if (c.sla.seen) details.push(`المشاهدة: ${SLA_LEVEL_LABELS[c.sla.seen.level] || c.sla.seen.level} (${c.sla.seen.elapsedMinutes}/${c.sla.seen.thresholdMinutes} د)`);
                                   if (c.sla.contact) details.push(`التواصل: ${SLA_LEVEL_LABELS[c.sla.contact.level] || c.sla.contact.level} (${c.sla.contact.elapsedMinutes}/${c.sla.contact.thresholdMinutes} د)`);
                                   if (c.sla.interestedFollowup) details.push(`المتابعة: ${SLA_LEVEL_LABELS[c.sla.interestedFollowup.level] || c.sla.interestedFollowup.level} (${c.sla.interestedFollowup.elapsedMinutes}/${c.sla.interestedFollowup.thresholdMinutes} د)`);
                                   if (details.length) slaBox.appendChild(el('div', { class: 'faint', style: 'font-size:11px;margin-top:4px' }, details.map((d) => el('div', {}, [d]))));
                         }
                         card.appendChild(slaBox);

           if (data.seenHistory && data.seenHistory.length > 0) {
                     const seenBox = el('div', {}, [
                                 el('div', { class: 'faint' }, ['تمت رؤيته بواسطة']),
                                 ...data.seenHistory.map((s) => el('div', { style: 'font-size:12.5px' }, [`${s.employeeName} — ${fmt.dateTime(s.seenAt)}`])),
                               ]);
                     card.appendChild(seenBox);
           } else {
                     card.appendChild(el('div', {}, [el('div', { class: 'faint' }, ['تمت رؤيته بواسطة']), el('div', { class: 'faint' }, ['لم تتم رؤيته بعد'])]));
           }

           updateNoteGuard();
                 }

                 function updateNoteGuard() {
                         App.clearNoteGuard();
                 }

                 function renderCustomer360Strip(c) {
                         const card = el('div', { class: 'card card-pad mb-16', style: 'display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start' });

           const scoreBox = el('div', {}, [
                     el('div', { class: 'faint' }, ['تقييم العميل']),
                     el('div', { style: 'font-size:24px;font-weight:800' }, [String(c.leadScore)]),
                   ]);
                         const reasonsBtn = el('button', { class: 'link-btn', style: 'font-size:11px' }, ['السبب؟ ▾']);
                         const reasonsBox = el('div', { class: 'faint', style: 'display:none;font-size:11px;max-width:260px' },
                                                       c.leadScoreReasons.length === 0 ? ['لا توجد إشارات تقييم بعد.'] :
                                                       c.leadScoreReasons.map((r) => el('div', {}, [`${r.points > 0 ? '+' : ''}${r.points} — ${r.label}`])));
                         reasonsBtn.onclick = () => { reasonsBox.style.display = reasonsBox.style.display === 'none' ? 'block' : 'none'; };
                         scoreBox.appendChild(reasonsBtn);
                         scoreBox.appendChild(reasonsBox);
                         card.appendChild(scoreBox);

           const slaBox = el('div', {}, [el('div', { class: 'faint' }, ['حالة الموعد']), badges.sla(c.sla?.worst)]);
                         if (c.sla) {
                                   const details = [];
                                   if (c.sla.seen) details.push(`المشاهدة: ${SLA_LEVEL_LABELS[c.sla.seen.level] || c.sla.seen.level} (${c.sla.seen.elapsedMinutes}/${c.sla.seen.thresholdMinutes} د)`);
                                   if (c.sla.contact) details.push(`التواصل: ${SLA_LEVEL_LABELS[c.sla.contact.level] || c.sla.contact.level} (${c.sla.contact.elapsedMinutes}/${c.sla.contact.thresholdMinutes} د)`);
                                   if (c.sla.interestedFollowup) details.push(`المتابعة: ${SLA_LEVEL_LABELS[c.sla.interestedFollowup.level] || c.sla.interestedFollowup.level} (${c.sla.interestedFollowup.elapsedMinutes}/${c.sla.interestedFollowup.thresholdMinutes} د)`);
                                   if (details.length) slaBox.appendChild(el('div', { class: 'faint', style: 'font-size:11px;margin-top:4px' }, details.map((d) => el('div', {}, [d]))));
                         }
                         card.appendChild(slaBox);

           if (data.seenHistory && data.seenHistory.length > 0) {
                     const seenBox = el('div', {}, [
                                 el('div', { class: 'faint' }, ['تمت رؤيته بواسطة']),
                                 ...data.seenHistory.map((s) => el('div', { style: 'font-size:12.5px' }, [`${s.employeeName} — ${fmt.dateTime(s.seenAt)}`])),
                               ]);
                     card.appendChild(seenBox);
           } else {
                     card.appendChild(el('div', {}, [el('div', { class: 'faint' }, ['تمت رؤيته بواسطة']), el('div', { class: 'faint' }, ['لم تتم رؤيته بعد'])]));
           }

           if (data.lifetimeValue) {
                     const lv = data.lifetimeValue;
                     card.appendChild(el('div', {}, [
                                 el('div', { class: 'faint' }, ['القيمة الدائمة']),
                                 el('div', { style: 'font-size:12.5px' }, [`${lv.orders} طلب · صافي ${lv.netRevenue.toLocaleString()} · متوسط الطلب ${lv.averageOrderValue.toLocaleString()}`]),
                               ]));
           }
                         return card;
                 }

                 function renderProducts() {
                         const wrap = el('div', { class: 'card card-pad' });
                         const list = el('div', { class: 'flex gap-8 mb-12', style: 'flex-wrap:wrap' },
                                                 data.products.length === 0 ? [el('div', { class: 'muted' }, ['لا يوجد اهتمام بمنتجات مسجّل.'])] :
                                                 data.products.map((p) => el('span', { class: 'badge', style: 'background:var(--surface-2)' }, [
                                                             p, ' ', el('button', { class: 'link-btn', style: 'font-size:10px;margin-inline-start:4px', onclick: async () => { await api('/customers/' + data.customer.id + '/products/' + encodeURIComponent(p), { method: 'DELETE' }); await load(); render(); } }, ['✕']),
                                                           ])));
                         const input = el('input', { placeholder: 'أضف منتجًا…', style: 'max-width:220px' });
                         wrap.appendChild(list);
                         wrap.appendChild(el('div', { class: 'flex gap-8 wrap' }, [input, el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
                                   if (!input.value.trim()) return;
                                   await api('/customers/' + data.customer.id + '/products', { method: 'POST', body: { product: input.value.trim() } });
                                   input.value = '';
                                   await load();
                                   render();
                         } }, ['إضافة'])]));
                         return wrap;
                 }

                 function renderCallAttempts() {
                         const wrap = el('div', { class: 'card card-pad' });
                         wrap.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px' }, ['📞 سجل المكالمات']));
                         if (data.callAttempts.length === 0) {
                                   wrap.appendChild(el('div', { class: 'muted' }, ['لا توجد محاولات اتصال مسجّلة بعد.']));
                                   return wrap;
                         }
                         wrap.appendChild(el('div', { class: 'table-wrap' }, [
                                   el('table', { class: 'data-table' }, [
                                               el('thead', {}, [el('tr', {}, ['الوقت', 'النتيجة', 'بواسطة', 'ملاحظات'].map((h) => el('th', {}, [h])))]),
                                               el('tbody', {}, data.callAttempts.map((a) => el('tr', {}, [
                                                             el('td', {}, [fmt.dateTime(a.created_at)]),
                                                             el('td', {}, [el('span', { style: `background:${CALL_OUTCOME_COLORS[a.outcome] || '#555'};color:#fff;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:700` }, [CALL_OUTCOME_LABELS[a.outcome] || a.outcome])]),
                                                             el('td', {}, [a.attempted_by_name || '—']),
                                                             el('td', {}, [a.notes || '—']),
                                                           ]))),
                                             ]),
                                 ]));
                         return wrap;
                 }

                   if (data.lifetimeValue) {
                             const lv = data.lifetimeValue;
                             card.appendChild(el('div', {}, [
                                         el('div', { class: 'faint' }, ['القيمة الدائمة']),
                                         el('div', { style: 'font-size:12.5px' }, [`${lv.orders} طلب`]),
                                       ]));
                   }
           return card;
   }

                 function renderProducts() {
           const wrap = el('div', { class: 'card card-pad' });
           const list = el('div', { class: 'flex gap-8 mb-12', style: 'flex-wrap:wrap' },
                                   data.products.length === 0 ? [el('div', { class: 'muted' }, ['لا يوجد اهتمام.'])] :
                                   data.products.map((p) => el('span', { class: 'badge', style: 'background:var(--surface-2)' }, [
                                               p, ' ', el('button', { class: 'link-btn', style: 'font-size:10px;margin-inline-start:4px', onclick: async () => { await api('/customers/' + data.customer.id + '/products/' + encodeURIComponent(p), { method: 'DELETE' }); await load(); render(); } }, ['✕']),
                                             ])));
           const input = el('input', { placeholder: 'أضف منتجًا…', style: 'max-width:220px' });
           wrap.appendChild(list);
           wrap.appendChild(el('div', { class: 'flex gap-8 wrap' }, [input, el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
                     if (!input.value.trim()) return;
                     await api('/customers/' + data.customer.id + '/products', { method: 'POST', body: { product: input.value.trim() } });
                     input.value = '';
                     await load();
                     render();
           } }, ['إضافة'])]));
           return wrap;
   }

     function renderCallAttempts() {
             const wrap = el('div', { class: 'card card-pad' });
             wrap.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px' }, ['📞 سجل المكالمات']));
             if (data.callAttempts.length === 0) {
                       wrap.appendChild(el('div', { class: 'muted' }, ['لا توجد محاولات اتصال مسجّلة بعد.']));
                       return wrap;
             }
             wrap.appendChild(el('div', { class: 'table-wrap' }, [
                       el('table', { class: 'data-table' }, [
                                   el('thead', {}, [el('tr', {}, ['الوقت', 'النتيجة', 'بواسطة', 'ملاحظات'].map((h) => el('th', {}, [h])))]),
                                   el('tbody', {}, data.callAttempts.map((a) => el('tr', {}, [
                                                 el('td', {}, [fmt.dateTime(a.created_at)]),
                                                 el('td', {}, [el('span', { style: `background:${CALL_OUTCOME_COLORS[a.outcome]||'#555'};color:#fff;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:700` }, [CALL_OUTCOME_LABELS[a.outcome] || a.outcome])]),
                                                 el('td', {}, [a.attempted_by_name || '—']),
                                                 el('td', {}, [a.notes || '—']),
                                               ]))),
                                 ]),
                     ]));
             return wrap;
     }

       if (data.lifetimeValue) {
                 const lv = data.lifetimeValue;
                 card.appendChild(el('div', {}, [
                             el('div', { class: 'faint' }, ['القيمة الدائمة']),
                             el('div', { style: 'font-size:12.5px' }, [lv.orders + ' طلب']),
                           ]));
       }
        return card;
}

      function renderProducts() {
        const wrap = el('div', { class: 'card card-pad' });
        const list = el('div', { class: 'flex gap-8 mb-12', style: 'flex-wrap:wrap' },
                                data.products.length === 0
                                  ? [el('div', { class: 'muted' }, ['لا يوجد اهتمام.'])]
                                  : data.products.map((p) => el('span', { class: 'badge' }, [p])));
        const input = el('input', { placeholder: 'أضف منتجًا…', style: 'max-width:220px' });
        wrap.appendChild(list);
        wrap.appendChild(el('div', { class: 'flex gap-8 wrap' }, [
                  input,
                  el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
                              if (!input.value.trim()) return;
                              await api('/customers/' + data.customer.id + '/products', { method: 'POST', body: { product: input.value.trim() } });
                              input.value = '';
                              await load();
                              render();
                  } }, ['إضافة']),
                ]));
        return wrap;
}

    function renderCallAttempts() {
            const wrap = el('div', { class: 'card card-pad' });
            wrap.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px' }, ['📞 سجل المكالمات']));
            if (data.callAttempts.length === 0) {
                      wrap.appendChild(el('div', { class: 'muted' }, ['لا توجد محاولات اتصال مسجّلة بعد.']));
                      return wrap;
            }
            wrap.appendChild(el('div', { class: 'table-wrap' }, [
                      el('table', { class: 'data-table' }, [
                                  el('thead', {}, [el('tr', {}, ['الوقت', 'النتيجة', 'بواسطة', 'ملاحظات'].map((h) => el('th', {}, [h])))]),
                                  el('tbody', {}, data.callAttempts.map((a) => el('tr', {}, [
                                                el('td', {}, [fmt.dateTime(a.created_at)]),
                                                el('td', {}, [el('span', { style: 'background:#555;color:#fff;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:700' }, [CALL_OUTCOME_LABELS[a.outcome] || a.outcome])]),
                                                el('td', {}, [a.attempted_by_name || '—']),
                                                el('td', {}, [a.notes || '—']),
                                              ]))),
                                ]),
                    ]));
            return wrap;
    }

    function renderSalesSection() {
            const wrap = el('div', { class: 'card card-pad' });
            wrap.appendChild(el('div', { class: 'flex gap-8 mb-12 wrap' }, [
                      el('button', { class: 'btn btn-sm btn-outline', onclick: () => logBranchVisit() }, ['🏪 زيارة فرع']),
                    ]));
            if (data.branchVisits.length > 0) {
                      wrap.appendChild(el('div', { style: 'font-weight:700;font-size:12.5px;margin-bottom:6px' }, ['زيارات الفرع']));
                      data.branchVisits.forEach((v) => wrap.appendChild(el('div', { class: 'faint mb-4', style: 'font-size:12px' }, [fmt.dateTime(v.visit_at) + ' — ' + v.branch_name])));
            }
            if (data.purchases.length === 0) {
                      wrap.appendChild(el('div', { class: 'muted mt-8' }, ['لا توجد مشتريات مسجّلة بعد.']));
                      return wrap;
            }
            wrap.appendChild(el('div', { style: 'font-weight:700;font-size:12.5px;margin:10px 0 6px' }, ['المشتريات']));
            data.purchases.forEach((p) => wrap.appendChild(renderPurchaseCard(p)));
            return wrap;
    }

    function renderPurchaseCard(p) {
            const netAmount = Math.round((p.total_amount - p.refunded_amount) * 100) / 100;
            const card = el('div', { class: 'card-pad mb-8', style: 'border:1px solid var(--border);border-radius:8px' });
            card.appendChild(el('div', { class: 'flex-between' }, [
                      el('div', { style: 'font-weight:700' }, ['#' + p.id + ' — ' + p.total_amount.toLocaleString() + ' ج.م']),
                      badges.dealStatus(p.status),
                    ]));
            if (p.refunded_amount > 0) {
                      card.appendChild(el('div', { class: 'faint', style: 'font-size:12px;color:var(--danger)' }, ['المسترجع: ' + p.refunded_amount.toLocaleString() + ' — الصافي: ' + netAmount.toLocaleString()]));
            }
            if (App.state.user.role === 'team_leader' && p.status !== 'CANCELLED') {
                      const actions = el('div', { class: 'flex gap-8 mt-8 wrap' });
                      if (p.status === 'COMPLETED' || p.status === 'PARTIALLY_REFUNDED') {
                                  actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => openRefundModal(p) }, ['↩ استرجاع']));
                      }
                      actions.appendChild(el('button', { class: 'btn btn-sm btn-outline', onclick: () => openAttributionModal(p) }, ['إعادة نسب الصفقة']));
                      actions.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => cancelPurchase(p) }, ['إبطال']));
                      card.appendChild(actions);
            }
            return card;
    }

    function round2(n) { return Math.round(n * 100) / 100; }

    async function logBranchVisit() {
            let branches = [];
            try { branches = (await api('/sales/branches')).branches; } catch (e) { toast(e.message, 'error'); return; }
            const branchSel = el('select', {}, branches.map((b) => el('option', { value: b.id }, [b.name])));
            const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
            const body = el('div', {}, [
                      el('div', { class: 'field' }, [el('label', {}, ['الفرع']), branchSel]),
                      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
                    ]);
            const dlg = modal('تسجيل زيارة فرع', body, []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-primary', onclick: async () => {
                                  try {
                                                await api('/sales/customers/' + data.customer.id + '/branch-visits', { method: 'POST', body: { branchId: Number(branchSel.value), notes: notesInput.value } });
                                                toast('تم تسجيل زيارة الفرع', 'success');
                                                dlg.close();
                                                await load();
                                                render();
                                  } catch (e) { toast(e.message, 'error'); }
                      } }, ['حفظ'])
                    );
    }

    async function openDealDoneModal() {
            let branches = [], settings = { paymentMethods: ['CASH'] }, employees = [];
            try {
                      [branches, settings, employees] = await Promise.all([
                                  api('/sales/branches').then((r) => r.branches),
                                  api('/sales/settings').then((r) => r.settings),
                                  api('/employees').then((r) => r.employees).catch(() => []),
                                ]);
            } catch (e) { toast(e.message, 'error'); return; }

      const branchSel = el('select', {}, branches.map((b) => el('option', { value: b.id }, [b.name])));
            const dateInput = el('input', { type: 'datetime-local', value: new Date().toISOString().slice(0, 16) });
            const invoiceInput = el('input', { placeholder: 'رقم الفاتورة (اختياري)' });
            const orderInput = el('input', { placeholder: 'رقم الطلب (اختياري)' });
            const paymentSel = el('select', {}, settings.paymentMethods.map((m) => el('option', { value: m }, [PAYMENT_METHOD_LABELS[m] || m])));
            const attribSel = el('select', {}, [
                      el('option', { value: '' }, ['— غير منسوبة —']),
                      ...employees.map((e) => el('option', { value: e.id }, [e.name])),
                    ]);
            const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
            const itemsBox = el('div');
            const items = [];
            function addItemRow() {
                      const row = { productName: el('input', { placeholder: 'المنتج' }), qty: el('input', { type: 'number', value: '1', min: '1', style: 'max-width:70px' }), price: el('input', { type: 'number', value: '0', step: '0.01', style: 'max-width:100px' }) };
                      items.push(row);
                      const rowEl = el('div', { class: 'flex gap-8 mb-8 wrap' }, [
                                  row.productName, row.qty, row.price,
                                  el('button', { class: 'btn btn-sm', onclick: () => { const idx = items.indexOf(row); if (idx > -1) items.splice(idx, 1); rowEl.remove(); recalc(); } }, ['✕']),
                                ]);
                      itemsBox.appendChild(rowEl);
                      [row.qty, row.price].forEach((inp) => inp.addEventListener('input', recalc));
            }
            const totalsBox = el('div', { class: 'flex-between mt-8', style: 'font-weight:700' }, [el('span', {}, ['الإجمالي']), el('span', { id: 'deal-total' }, ['0.00'])]);
            function recalc() {
                      const total = items.reduce((s, r) => s + Number(r.qty.value || 0) * Number(r.price.value || 0), 0);
                      totalsBox.querySelector('#deal-total').textContent = total.toLocaleString() + ' ج.م';
            }
            addItemRow();

      const body = el('div', {}, [
                el('div', { class: 'field' }, [el('label', {}, ['الفرع (مطلوب)']), branchSel]),
                el('div', { class: 'field' }, [el('label', {}, ['تاريخ ووقت الشراء']), dateInput]),
                el('div', { class: 'field' }, [el('label', {}, ['رقم الفاتورة']), invoiceInput]),
                el('div', { class: 'field' }, [el('label', {}, ['رقم الطلب']), orderInput]),
                el('div', { class: 'field' }, [el('label', {}, ['طريقة الدفع']), paymentSel]),
                el('div', { class: 'field' }, [el('label', {}, ['الموظف المنسوب إليه']), attribSel]),
                el('div', { class: 'field' }, [el('label', {}, ['الأصناف']), itemsBox, el('button', { class: 'btn btn-sm btn-outline', onclick: addItemRow }, ['+ إضافة صنف'])]),
                totalsBox,
                el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
              ]);
            const dlg = modal('تأكيد إتمام الصفقة', body, []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-success', onclick: async () => {
                                  const payloadItems = items.map((r) => ({ productName: r.productName.value.trim(), quantity: Number(r.qty.value || 1), unitPrice: Number(r.price.value || 0) })).filter((it) => it.productName);
                                  if (payloadItems.length === 0) { toast('مطلوب صنف واحد على الأقل', 'error'); return; }
                                  try {
                                                await api('/sales/customers/' + data.customer.id + '/purchases', {
                                                                method: 'POST',
                                                                body: {
                                                                                  branchId: Number(branchSel.value),
                                                                                  purchaseAt: new Date(dateInput.value).toISOString(),
                                                                                  invoiceNumber: invoiceInput.value.trim() || null,
                                                                                  orderId: orderInput.value.trim() || null,
                                                                                  items: payloadItems,
                                                                                  paymentMethod: paymentSel.value,
                                                                                  attributedEmployeeId: attribSel.value ? Number(attribSel.value) : null,
                                                                                  notes: notesInput.value,
                                                                },
                                                });
                                                toast('🎉 تم تسجيل الصفقة', 'success');
                                                dlg.close();
                                                await load();
                                                render();
                                  } catch (e) { toast(e.message, 'error'); }
                      } }, ['تأكيد إتمام الصفقة'])
                    );
    }

    function openRefundModal(p) {
            const remaining = round2(p.total_amount - p.refunded_amount);
            const amountInput = el('input', { type: 'number', step: '0.01', value: String(remaining) });
            const reasonInput = el('input', { placeholder: 'السبب' });
            const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
            const body = el('div', {}, [
                      el('div', { class: 'faint mb-8' }, ['الرصيد القابل للاسترجاع: ' + remaining.toLocaleString() + ' ج.م']),
                      el('div', { class: 'field' }, [el('label', {}, ['مبلغ الاسترجاع']), amountInput]),
                      el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
                      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
                    ]);
            const dlg = modal('استرجاع الصفقة رقم ' + p.id, body, []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-danger', onclick: async () => {
                                  try {
                                                await api('/sales/purchases/' + p.id + '/refunds', { method: 'POST', body: { refundAmount: Number(amountInput.value), refundReason: reasonInput.value, refundNotes: notesInput.value } });
                                                toast('تم تسجيل الاسترجاع', 'success');
                                                dlg.close(); await load(); render();
                                  } catch (e) { toast(e.message, 'error'); }
                      } }, ['تأكيد الاسترجاع'])
                    );
    }

    async function openAttributionModal(p) {
            let employees = [];
            try { employees = (await api('/employees')).employees; } catch {}
            const sel = el('select', {}, [el('option', { value: '' }, ['— غير منسوبة —']), ...employees.map((e) => el('option', { value: e.id }, [e.name]))]);
            const reasonInput = el('input', { placeholder: 'سبب التغيير (مطلوب)' });
            const body = el('div', {}, [
                      el('div', { class: 'field' }, [el('label', {}, ['الموظف الجديد المنسوب إليه']), sel]),
                      el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
                    ]);
            const dlg = modal('إعادة نسب الصفقة', body, []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-primary', onclick: async () => {
                                  if (!reasonInput.value.trim()) { toast('السبب مطلوب', 'error'); return; }
                                  try {
                                                await api('/sales/purchases/' + p.id + '/attribution', { method: 'POST', body: { newEmployeeId: sel.value || null, reason: reasonInput.value.trim() } });
                                                toast('تم تحديث النسب', 'success');
                                                dlg.close(); await load(); render();
                                  } catch (e) { toast(e.message, 'error'); }
                      } }, ['حفظ'])
                    );
    }

    async function cancelPurchase(p) {
            const reason = prompt('سبب إبطال هذه الصفقة:');
            if (reason === null) return;
            try {
                      await api('/sales/purchases/' + p.id + '/cancel', { method: 'POST', body: { reason } });
                      toast('تم إبطال الصفقة', 'success');
                      await load(); render();
            } catch (e) { toast(e.message, 'error'); }
    }

    function renderInfoCard(c) {
            const rows = [
                      ['كود العميل', c.id], ['الاسم', c.name || '—'], ['الأولوية', null],
                      ['المصدر', c.source || '—'], ['الحملة', c.campaign || '—'], ['المنتج', c.product || '—'],
                      ['تاريخ الإنشاء', fmt.dateTime(c.createdAt)], ['آخر تحديث', fmt.dateTime(c.updatedAt)],
                      ['المتابعة القادمة', c.nextFollowUpAt ? fmt.dateTime(c.nextFollowUpAt) : '—'],
                    ];
            if (c.closedAt) rows.push(['تاريخ الإغلاق', fmt.dateTime(c.closedAt)]);
            const card = el('div', { class: 'card card-pad' });
            rows.forEach(([label, value]) => {
                      card.appendChild(el('div', { class: 'flex-between mb-8', style: 'font-size:13.5px' }, [el('span', { class: 'muted' }, [label]), value === null ? badges.priority(c.priority) : el('span', {}, [value])]));
            });
            return card;
    }

    function openRefundModal(p) {
            const remaining = round2(p.total_amount - p.refunded_amount);
            const amountInput = el('input', { type: 'number', step: '0.01', value: String(remaining) });
            const reasonInput = el('input', { placeholder: 'السبب' });
            const body = el('div', {}, [
                      el('div', { class: 'field' }, [el('label', {}, ['مبلغ الاسترجاع']), amountInput]),
                      el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
                    ]);
            const dlg = modal('استرجاع الصفقة رقم ' + p.id, body, []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-danger', onclick: async () => {
                                  try {
                                                await api('/sales/purchases/' + p.id + '/refunds', { method: 'POST', body: { refundAmount: Number(amountInput.value), refundReason: reasonInput.value } });
                                                toast('تم تسجيل الاسترجاع', 'success');
                                                dlg.close(); await load(); render();
                                  } catch (e) { toast(e.message, 'error'); }
                      } }, ['تأكيد الاسترجاع'])
                    );
    }

    async function cancelPurchase(p) {
            const reason = prompt('سبب إبطال هذه الصفقة:');
            if (reason === null) return;
            try {
                      await api('/sales/purchases/' + p.id + '/cancel', { method: 'POST', body: { reason } });
                      toast('تم إبطال الصفقة', 'success');
                      await load(); render();
            } catch (e) { toast(e.message, 'error'); }
    }

    async function openAttributionModal(p) {
            let employees = [];
            try { employees = (await api('/employees')).employees; } catch {}
            const sel = el('select', {}, [el('option', { value: '' }, ['— غير منسوبة —']), ...employees.map((e) => el('option', { value: e.id }, [e.name]))]);
            const reasonInput = el('input', { placeholder: 'السبب (مطلوب)' });
            const dlg = modal('إعادة نسب الصفقة', el('div', {}, [
                      el('div', { class: 'field' }, [el('label', {}, ['الموظف الجديد']), sel]),
                      el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
                    ]), []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-primary', onclick: async () => {
                                  if (!reasonInput.value.trim()) { toast('السبب مطلوب', 'error'); return; }
                                  try {
                                                await api('/sales/purchases/' + p.id + '/attribution', { method: 'POST', body: { newEmployeeId: sel.value || null, reason: reasonInput.value.trim() } });
                                                toast('تم تحديث النسب', 'success');
                                                dlg.close(); await load(); render();
                                  } catch (e) { toast(e.message, 'error'); }
                      } }, ['حفظ'])
                    );
    }

    function renderInfoCard(c) {
            const rows = [
                      ['كود العميل', c.id], ['الاسم', c.name || '—'], ['الأولوية', null],
                      ['المصدر', c.source || '—'], ['تاريخ الإنشاء', fmt.dateTime(c.createdAt)],
                      ['آخر تحديث', fmt.dateTime(c.updatedAt)],
                    ];
            if (c.closedAt) rows.push(['تاريخ الإغلاق', fmt.dateTime(c.closedAt)]);
            const card = el('div', { class: 'card card-pad' });
            rows.forEach(([label, value]) => {
                      card.appendChild(el('div', { class: 'flex-between mb-8', style: 'font-size:13.5px' }, [el('span', { class: 'muted' }, [label]), value === null ? badges.priority(c.priority) : el('span', {}, [value])]));
            });
            return card;
    }

    function openRefundModal(p) {
            const amountInput = el('input', { type: 'number', step: '0.01', value: String(round2(p.total_amount - p.refunded_amount)) });
            const reasonInput = el('input', { placeholder: 'السبب' });
            const dlg = modal('استرجاع', el('div', {}, [
                      el('div', { class: 'field' }, [el('label', {}, ['المبلغ']), amountInput]),
                      el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
                    ]), []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-danger', onclick: async () => {
                                  try { await api('/sales/purchases/' + p.id + '/refunds', { method: 'POST', body: { refundAmount: Number(amountInput.value), refundReason: reasonInput.value } }); toast('تم', 'success'); dlg.close(); await load(); render(); }
                                  catch (e) { toast(e.message, 'error'); }
                      } }, ['تأكيد'])
                    );
    }

    async function cancelPurchase(p) {
            const reason = prompt('سبب الإبطال:');
            if (reason === null) return;
            try { await api('/sales/purchases/' + p.id + '/cancel', { method: 'POST', body: { reason } }); toast('تم إبطال الصفقة', 'success'); await load(); render(); }
            catch (e) { toast(e.message, 'error'); }
    }

    async function openAttributionModal(p) {
            let employees = [];
            try { employees = (await api('/employees')).employees; } catch {}
            const sel = el('select', {}, [el('option', { value: '' }, ['— غير منسوبة —']), ...employees.map((e) => el('option', { value: e.id }, [e.name]))]);
            const reasonInput = el('input', { placeholder: 'السبب (مطلوب)' });
            const dlg = modal('إعادة نسب الصفقة', el('div', {}, [el('div', { class: 'field' }, [el('label', {}, ['الموظف']), sel]), el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput])]), []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['إلغاء']),
                      el('button', { class: 'btn btn-primary', onclick: async () => {
                                  if (!reasonInput.value.trim()) { toast('السبب مطلوب', 'error'); return; }
                                  try { await api('/sales/purchases/' + p.id + '/attribution', { method: 'POST', body: { newEmployeeId: sel.value || null, reason: reasonInput.value.trim() } }); toast('تم', 'success'); dlg.close(); await load(); render(); }
                                  catch (e) { toast(e.message, 'error'); }
                      } }, ['حفظ'])
                    );
    }

    function renderInfoCard(c) {
            const card = el('div', { class: 'card card-pad' });
            [['كود العميل', c.id], ['الاسم', c.name || '—'], ['الأولوية', null], ['المصدر', c.source || '—'], ['تاريخ الإنشاء', fmt.dateTime(c.createdAt)], ['آخر تحديث', fmt.dateTime(c.updatedAt)]].forEach(([label, value]) => {
                      card.appendChild(el('div', { class: 'flex-between mb-8', style: 'font-size:13.5px' }, [el('span', { class: 'muted' }, [label]), value === null ? badges.priority(c.priority) : el('span', {}, [value])]));
            });
            return card;
    }
    function renderActionsCard(c) {
            const card = el('div', { class: 'card card-pad' });
            card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:12px' }, ['الإجراءات']));
            card.appendChild(el('div', { style: 'background:linear-gradient(135deg,#fff3cd,#ffeeba);border:1px solid #ffc107;border-radius:12px;padding:10px 14px;margin-bottom:12px;text-align:center;font-size:13px;font-weight:700;color:#856404;line-height:1.6' }, ['متنساش تكتب ملاحظة للعميل عشان الرقم ميتسحبش منك']));
            card.appendChild(el('a', { class: 'btn btn-outline btn-block mb-8', href: 'tel:' + c.normalizedPhone, onclick: () => api('/customers/' + c.id + '/call', { method: 'POST' }).catch(() => {}) }, ['اتصال بالعميل']));
            const chipSectionStyle = 'background:var(--surface-2);border-radius:16px;padding:16px;margin-bottom:14px;border:1px solid var(--border)';
            const chipTitleStyle = 'font-weight:800;font-size:14px;margin-bottom:12px;color:var(--text)';
            const chipGridStyle = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-bottom:12px';
            const chipBaseStyle = 'color:#fff;padding:8px 6px;border-radius:20px;font-size:12.5px;font-weight:700;border:3px solid transparent;cursor:pointer;transition:all .2s ease;text-align:center;line-height:1.3';
            const chipActiveExtra = 'transform:scale(1.05);box-shadow:0 2px 8px rgba(0,0,0,.25)';
            const saveBtnStyle = 'color:#fff;font-weight:800;padding:11px 0;border-radius:14px;font-size:14px;width:100%;border:none;cursor:pointer;transition:background .2s';
            const OUTCOME_ALLOWED_STATUSES = { ANSWERED:['FOLLOW_UP','AGREED'], NO_ANSWER:['NO_ANSWER'], BUSY:['NO_ANSWER','FOLLOW_UP'], WRONG_NUMBER:['NO_ANSWER'], SWITCHED_OFF:['NO_ANSWER','FOLLOW_UP'], REJECTED:['NO_ANSWER'] };
            const OUTCOME_AUTO_STATUS = { NO_ANSWER:'NO_ANSWER', WRONG_NUMBER:'NO_ANSWER' };
            const unifiedSection = el('div', { style: chipSectionStyle });
            unifiedSection.appendChild(el('div', { style: chipTitleStyle }, ['سجل المكالمة']));
            const outcomeBtnsWrap = el('div', { style: chipGridStyle });
            let selectedOutcome = null;
            let selectedStatus = SELECTABLE_STATUSES.includes(c.status) ? c.status : null;
            const outcomeBtns = [];
            function refreshCallChips() {
                      outcomeBtns.forEach((b, i) => {
                                  const isOn = CALL_OUTCOMES[i][0] === selectedOutcome;
                                  b.style.opacity = isOn ? '1' : '0.5';
                                  b.style.borderColor = isOn ? 'rgba(255,255,255,.7)' : 'transparent';
                                  b.style.cssText = b.style.cssText.replace(/transform:[^;]+;?/g,'').replace(/box-shadow:[^;]+;?/g,'');
                                  if (isOn) b.style.cssText += ';' + chipActiveExtra;
                      });
            }
            CALL_OUTCOMES.forEach(([val, label]) => {
                      const btn = el('button', {
                                  style: 'background:' + CALL_OUTCOME_COLORS[val] + ';' + chipBaseStyle + ';opacity:0.5',
                                  onclick: () => {
                                                selectedOutcome = val;
                                                refreshCallChips();
                                                if (OUTCOME_AUTO_STATUS[val]) {
                                                                selectedStatus = OUTCOME_AUTO_STATUS[val];
                                                } else {
                                                                const allowed = OUTCOME_ALLOWED_STATUSES[val] || SELECTABLE_STATUSES;
                                                                if (selectedStatus && !allowed.includes(selectedStatus)) selectedStatus = null;
                                                }
                                                refreshStatusChips();
                                                statusWrap.style.display = '';
                                                noteWrap.style.display = '';
                                                unifiedSaveBtn.style.display = '';
                                  },
                      }, [label]);
                      outcomeBtns.push(btn);
                      outcomeBtnsWrap.appendChild(btn);
            });
            unifiedSection.appendChild(outcomeBtnsWrap);
            const STATUS_CHIP_COLORS = { NO_ANSWER:'#95a5a6', FOLLOW_UP:'#e67e22', AGREED:'#27ae60' };
            const statusWrap = el('div', { style: 'display:none' });
            statusWrap.appendChild(el('div', { style: 'font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:600' }, ['الحالة:']));
            const statusBtnsWrap = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px' });
            const statusBtns = [];
            function refreshStatusChips() {
                      const allowed = selectedOutcome ? (OUTCOME_ALLOWED_STATUSES[selectedOutcome] || SELECTABLE_STATUSES) : SELECTABLE_STATUSES;
                      statusBtns.forEach((b, i) => {
                                  const val = SELECTABLE_STATUSES[i];
                                  const isAllowed = allowed.includes(val);
                                  const isOn = val === selectedStatus;
                                  b.disabled = !isAllowed;
                                  b.style.opacity = !isAllowed ? '0.15' : (isOn ? '1' : '0.5');
                                  b.style.borderColor = isOn && isAllowed ? 'rgba(255,255,255,.7)' : 'transparent';
                                  b.style.cursor = isAllowed ? 'pointer' : 'not-allowed';
                                  b.style.cssText = b.style.cssText.replace(/transform:[^;]+;?/g,'').replace(/box-shadow:[^;]+;?/g,'');
                                  if (isOn && isAllowed) b.style.cssText += ';' + chipActiveExtra;
                      });
            }
            SELECTABLE_STATUSES.forEach((val) => {
                      const isActive = val === selectedStatus;
                      const btn = el('button', {
                                  style: 'background:' + STATUS_CHIP_COLORS[val] + ';' + chipBaseStyle + ';opacity:' + (isActive ? '1' : '0.5') + (isActive ? ';border-color:rgba(255,255,255,.7);' + chipActiveExtra : ''),
                                  onclick: () => {
                                                const allowed = selectedOutcome ? (OUTCOME_ALLOWED_STATUSES[selectedOutcome] || SELECTABLE_STATUSES) : SELECTABLE_STATUSES;
                                                if (!allowed.includes(val)) return;
                                                selectedStatus = val;
                                                refreshStatusChips();
                                  },
                      }, [STATUS_LABELS[val] || val]);
                      statusBtns.push(btn);
                      statusBtnsWrap.appendChild(btn);
            });
            statusWrap.appendChild(statusBtnsWrap);
            if (!SELECTABLE_STATUSES.includes(c.status)) {
                      statusWrap.appendChild(el('div', { style: 'font-size:11.5px;color:var(--muted);margin-bottom:10px;text-align:center;opacity:.7' }, ['الحالة الحالية: ' + (STATUS_LABELS[c.status] || c.status)]));
            }
            unifiedSection.appendChild(statusWrap);
            const noteWrap = el('div', { style: 'display:none' });
            const callNotes = el('textarea', { placeholder: 'اكتب ملاحظة (إجباري)...', style: 'width:100%;min-height:48px;border-radius:12px;padding:10px 12px;font-size:13px;border:2px solid #e74c3c;background:var(--surface);color:var(--text);resize:vertical;margin-bottom:12px;font-family:inherit' });
            noteWrap.appendChild(callNotes);
            unifiedSection.appendChild(noteWrap);
            const unifiedSaveBtn = el('button', { style: 'background:linear-gradient(135deg,#e74c3c,#c0392b);' + saveBtnStyle + ';display:none', onclick: async () => {
                      if (!selectedOutcome) { toast('اختار نتيجة المكالمة الأول', 'error'); return; }
                      if (!callNotes.value.trim()) { toast('لازم تكتب ملاحظة الأول', 'error'); callNotes.focus(); return; }
                      unifiedSaveBtn.disabled = true;
                      unifiedSaveBtn.textContent = 'جارِ الحفظ...';
                      try {
                                  await api('/customers/' + c.id + '/call-attempts', { method: 'POST', body: { outcome: selectedOutcome, notes: callNotes.value } });
                                  await api('/customers/' + c.id + '/notes', { method: 'POST', body: { note: callNotes.value.trim() } });
                                  let statusMsg = '';
                                  if (selectedStatus && selectedStatus !== c.status) {
                                                const res = await api('/customers/' + c.id + '/status', { method: 'PATCH', body: { status: selectedStatus } });
                                                if (res.autoFollowup) statusMsg = ' — تم جدولة إعادة اتصال بعد ١٥ دقيقة';
                                  }
                                  const NON_RECLAIM_OUTCOMES = ['ANSWERED', 'REJECTED'];
                                  if (!NON_RECLAIM_OUTCOMES.includes(selectedOutcome)) {
                                                toast('الرقم اتسحب — النتيجة مش رد أو رفض', 'info');
                                  } else {
                                                toast('تم تسجيل كل حاجة بنجاح' + statusMsg, 'success');
                                  }
                                  await load(); render();
                      } catch (e) { toast(e.message, 'error'); }
                      finally { unifiedSaveBtn.disabled = false; unifiedSaveBtn.textContent = 'سجل وحدث'; }
            } }, ['سجل وحدث']);
            unifiedSection.appendChild(unifiedSaveBtn);
            card.appendChild(unifiedSection);
            SELECTABLE_STATUSES.forEach((val) => {
                      const isActive = val === selectedStatus;
                      const btn = el('button', {
                                  style: 'background:' + STATUS_CHIP_COLORS[val] + ';' + chipBaseStyle + ';opacity:' + (isActive ? '1' : '0.5'),
                                  onclick: () => {
                                                const allowed = selectedOutcome ? (OUTCOME_ALLOWED_STATUSES[selectedOutcome] || SELECTABLE_STATUSES) : SELECTABLE_STATUSES;
                                                if (!allowed.includes(val)) return;
                                                selectedStatus = val; refreshStatusChips();
                                  },
                      }, [STATUS_LABELS[val] || val]);
                      statusBtns.push(btn); statusBtnsWrap.appendChild(btn);
            });
            statusWrap.appendChild(statusBtnsWrap);
            if (!SELECTABLE_STATUSES.includes(c.status)) {
                      statusWrap.appendChild(el('div', { style: 'font-size:11.5px;color:var(--muted);margin-bottom:10px;text-align:center' }, ['الحالة الحالية: ' + (STATUS_LABELS[c.status] || c.status)]));
            }
            unifiedSection.appendChild(statusWrap);
            const noteWrap = el('div', { style: 'display:none' });
            const callNotes = el('textarea', { placeholder: 'اكتب ملاحظة...', style: 'width:100%;min-height:48px;border-radius:12px;padding:10px 12px;font-size:13px;border:2px solid #e74c3c;background:var(--surface);color:var(--text);resize:vertical;margin-bottom:12px;font-family:inherit' });
            noteWrap.appendChild(callNotes);
            unifiedSection.appendChild(noteWrap);
            const unifiedSaveBtn = el('button', { style: 'background:linear-gradient(135deg,#e74c3c,#c0392b);' + saveBtnStyle + ';display:none', onclick: async () => {
                      if (!selectedOutcome) { toast('اختار نتيجة المكالمة الأول', 'error'); return; }
                      if (!callNotes.value.trim()) { toast('لازم تكتب ملاحظة الأول', 'error'); callNotes.focus(); return; }
                      unifiedSaveBtn.disabled = true; unifiedSaveBtn.textContent = 'جارِ الحفظ...';
                      try {
                                  await api('/customers/' + c.id + '/call-attempts', { method: 'POST', body: { outcome: selectedOutcome, notes: callNotes.value } });
                                  await api('/customers/' + c.id + '/notes', { method: 'POST', body: { note: callNotes.value.trim() } });
                                  let statusMsg = '';
                                  if (selectedStatus && selectedStatus !== c.status) {
                                                const res = await api('/customers/' + c.id + '/status', { method: 'PATCH', body: { status: selectedStatus } });
                                                if (res.autoFollowup) statusMsg = ' — جدولة اعادة اتصال';
                                  }
                                  if (!['ANSWERED','REJECTED'].includes(selectedOutcome)) { toast('الرقم اتسحب', 'info'); }
                                  else { toast('تم التسجيل' + statusMsg, 'success'); }
                                  await load(); render();
                      } catch (e) { toast(e.message, 'error'); }
                      finally { unifiedSaveBtn.disabled = false; unifiedSaveBtn.textContent = 'سجل وحدث'; }
            } }, ['سجل وحدث']);
            unifiedSection.appendChild(unifiedSaveBtn);
            card.appendChild(unifiedSection);

      if (data.notes.length > 0) {
                const notesSection = el('div', { style: chipSectionStyle });
                notesSection.appendChild(el('div', { style: chipTitleStyle }, ['الملاحظات السابقة']));
                data.notes.forEach((n) => {
                            notesSection.appendChild(el('div', { style: 'margin-bottom:10px;padding:10px 12px;background:var(--surface);border-radius:12px;border:1px solid var(--border)' }, [
                                          el('div', { style: 'font-size:13.5px;color:var(--text);line-height:1.6' }, [n.note]),
                                          el('div', { style: 'font-size:11px;color:var(--muted);margin-top:4px' }, [n.author_name + ' - ' + fmt.dateTime(n.created_at)]),
                                        ]));
                });
                card.appendChild(notesSection);
      }

      card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(c.phone); toast('تم نسخ الرقم', 'success'); } }, ['نسخ الرقم']));

      const waBtn = el('button', {
                class: 'btn btn-block mb-8 ' + (c.whatsappContactStatus === 'NOT_CONTACTED' ? 'btn-whatsapp' : 'btn-whatsapp done'),
                onclick: c.whatsappContactStatus === 'NOT_CONTACTED' ? () => openWhatsAppModal(c) : null,
                style: c.whatsappContactStatus !== 'NOT_CONTACTED' ? 'cursor:default;opacity:.85' : '',
      }, [c.whatsappContactStatus === 'NOT_CONTACTED' ? 'ارسال واتساب' : 'تم التواصل واتساب']);
            card.appendChild(waBtn);

      if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
                card.appendChild(el('button', { class: 'btn btn-whatsapp btn-block mb-8', style: 'background:var(--primary,#2563eb)', onclick: () => openWhatsAppModal(c, true) }, ['تواصل مرة اخرى']));
                card.appendChild(el('div', { class: 'faint mb-4' }, ['وقت التواصل: ', el('span', { class: 'mono' }, [fmt.dateTime(c.whatsappContactedAt)])]));
                if (c.whatsappContactedByName) card.appendChild(el('div', { class: 'faint mb-4' }, ['تم بواسطة: ' + c.whatsappContactedByName]));

              const waFollowupWrap = el('div', { style: 'background:var(--surface-2);border-radius:14px;padding:12px;margin-bottom:12px;border:1px solid var(--border)' });
                waFollowupWrap.appendChild(el('div', { style: 'font-weight:800;font-size:13px;margin-bottom:10px;color:var(--text);text-align:center' }, ['حدد حالة العميل بعد الواتساب']));
                const waChips = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
                const WA_FOLLOWUP_OPTIONS = [{ action:'AGREED', label:'تم الاتفاق', bg:'#27ae60' }, { action:'FOLLOW_UP', label:'متابعة', bg:'#e67e22' }, { action:'AWAITING_REPLY', label:'انتظار رد', bg:'#95a5a6' }];
                const dimStyle = 'background:#d5d8dc;color:#7f8c8d;padding:10px 6px;border-radius:12px;font-size:12px;font-weight:700;border:none;cursor:pointer;text-align:center;line-height:1.4';
                let waSelectedAction = null;
                const allWaChipBtns = [];
                WA_FOLLOWUP_OPTIONS.forEach(opt => {
                            const chip = el('button', { style: dimStyle }, [opt.label]);
                            allWaChipBtns.push({ chip, opt });
                            chip.onclick = async () => {
                                          if (waSelectedAction === opt.action) return;
                                          waSelectedAction = opt.action;
                                          allWaChipBtns.forEach(b => { if (b.opt.action === opt.action) { b.chip.style.background = b.opt.bg; b.chip.style.color = '#fff'; } else { b.chip.style.background = '#d5d8dc'; b.chip.style.color = '#7f8c8d'; } b.chip.disabled = true; });
                                          try {
                                                          const res = await api('/customers/' + c.id + '/whatsapp-followup', { method: 'POST', body: { action: opt.action } });
                                                          toast(res.reclaimed ? 'تم — العميل رجع للمجمع' : 'تم تحديث الحالة', 'success');
                                                          await load(); render();
                                          } catch (e) {
                                                          toast(e.message, 'error');
                                                          waSelectedAction = null;
                                                          allWaChipBtns.forEach(b => { b.chip.style.background = '#d5d8dc'; b.chip.style.color = '#7f8c8d'; b.chip.disabled = false; });
                                          }
                            };
                            waChips.appendChild(chip);
                });
                waFollowupWrap.appendChild(waChips);
                card.appendChild(waFollowupWrap);
      }

      if (data.notes.length > 0) {
                const notesSection = el('div', { style: chipSectionStyle });
                notesSection.appendChild(el('div', { style: chipTitleStyle }, ['الملاحظات السابقة']));
                data.notes.forEach((n) => {
                            notesSection.appendChild(el('div', { style: 'margin-bottom:10px;padding:10px;background:var(--surface);border-radius:12px' }, [
                                          el('div', {}, [n.note]),
                                          el('div', { style: 'font-size:11px;color:var(--muted)' }, [n.author_name + ' - ' + fmt.dateTime(n.created_at)]),
                                        ]));
                });
                card.appendChild(notesSection);
      }

      card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(c.phone); toast('تم نسخ الرقم', 'success'); } }, ['نسخ الرقم']));

      const waBtn = el('button', {
                class: 'btn btn-block mb-8 ' + (c.whatsappContactStatus === 'NOT_CONTACTED' ? 'btn-whatsapp' : 'btn-whatsapp done'),
                onclick: c.whatsappContactStatus === 'NOT_CONTACTED' ? () => openWhatsAppModal(c) : null,
                style: c.whatsappContactStatus !== 'NOT_CONTACTED' ? 'cursor:default;opacity:.85' : '',
      }, [c.whatsappContactStatus === 'NOT_CONTACTED' ? 'ارسال واتساب' : 'تم التواصل واتساب']);
            card.appendChild(waBtn);
            card.appendChild(waBtn);

      if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
                card.appendChild(el('button', { class: 'btn btn-whatsapp btn-block mb-8', style: 'background:var(--primary,#2563eb)', onclick: () => openWhatsAppModal(c, true) }, ['تواصل مرة اخرى']));
                card.appendChild(el('div', { class: 'faint mb-4' }, ['وقت التواصل: ', el('span', { class: 'mono' }, [fmt.dateTime(c.whatsappContactedAt)])]));
                if (c.whatsappContactedByName) card.appendChild(el('div', { class: 'faint mb-4' }, ['تم بواسطة: ' + c.whatsappContactedByName]));
                const waFollowupWrap = el('div', { style: 'background:var(--surface-2);border-radius:14px;padding:12px;margin-bottom:12px;border:1px solid var(--border)' });
                waFollowupWrap.appendChild(el('div', { style: 'font-weight:800;font-size:13px;margin-bottom:10px;text-align:center' }, ['حدد حالة العميل بعد الواتساب']));
                const waChips = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
                const WA_OPTS = [{ action:'AGREED', label:'تم الاتفاق', bg:'#27ae60' }, { action:'FOLLOW_UP', label:'متابعة', bg:'#e67e22' }, { action:'AWAITING_REPLY', label:'انتظار رد', bg:'#95a5a6' }];
                const dimSt = 'background:#d5d8dc;color:#7f8c8d;padding:10px 6px;border-radius:12px;font-size:12px;font-weight:700;border:none;cursor:pointer;text-align:center';
                let waSel = null; const waChipBtns = [];
                WA_OPTS.forEach(opt => {
                            const chip = el('button', { style: dimSt }, [opt.label]);
                            waChipBtns.push({ chip, opt });
                            chip.onclick = async () => {
                                          if (waSel === opt.action) return; waSel = opt.action;
                                          waChipBtns.forEach(b => { if (b.opt.action === opt.action) { b.chip.style.background = b.opt.bg; b.chip.style.color = '#fff'; } else { b.chip.style.background = '#d5d8dc'; b.chip.style.color = '#7f8c8d'; } b.chip.disabled = true; });
                                          try { const res = await api('/customers/' + c.id + '/whatsapp-followup', { method: 'POST', body: { action: opt.action } }); toast(res.reclaimed ? 'تم — العميل رجع' : 'تم التحديث', 'success'); await load(); render(); }
                                          catch (e) { toast(e.message, 'error'); waSel = null; waChipBtns.forEach(b => { b.chip.style.background = '#d5d8dc'; b.chip.style.color = '#7f8c8d'; b.chip.disabled = false; }); }
                            };
                            waChips.appendChild(chip);
                });
                waFollowupWrap.appendChild(waChips); card.appendChild(waFollowupWrap);
      }

      card.appendChild(el('hr', { style: 'border-color:var(--border);margin:14px 0' }));
            if (c.status !== 'CLOSED') card.appendChild(el('button', { class: 'btn btn-success btn-block mb-8', onclick: () => openDealDoneModal() }, ['تمت الصفقة']));
            if (c.status === 'CLOSED' && App.state.user.role === 'team_leader') card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => reopenCustomer(c) }, ['اعادة فتح العميل']));
            card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => scheduleFollowup(c) }, ['جدولة متابعة']));
            return card;
    }
      card.appendChild(waBtn);

      if (c.whatsappContactStatus !== 'NOT_CONTACTED') {
                card.appendChild(el('button', { class: 'btn btn-whatsapp btn-block mb-8', style: 'background:var(--primary,#2563eb)', onclick: () => openWhatsAppModal(c, true) }, ['تواصل مرة اخرى']));
                card.appendChild(el('div', { class: 'faint mb-4' }, ['وقت التواصل: ', el('span', { class: 'mono' }, [fmt.dateTime(c.whatsappContactedAt)])]));
                if (c.whatsappContactedByName) card.appendChild(el('div', { class: 'faint mb-4' }, ['تم بواسطة: ' + c.whatsappContactedByName]));
      }

      card.appendChild(el('hr', { style: 'border-color:var(--border);margin:14px 0' }));
      if (c.status !== 'CLOSED') card.appendChild(el('button', { class: 'btn btn-success btn-block mb-8', onclick: () => openDealDoneModal() }, ['تمت الصفقة']));
      if (c.status === 'CLOSED' && App.state.user.role === 'team_leader') card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => reopenCustomer(c) }, ['اعادة فتح العميل']));
      card.appendChild(el('button', { class: 'btn btn-outline btn-block mb-8', onclick: () => scheduleFollowup(c) }, ['جدولة متابعة']));
      return card;
}

    async function reopenCustomer(c) {
            if (!confirm('اعادة فتح هذا العميل؟')) return;
            await api('/customers/' + c.id + '/reopen', { method: 'POST' });
            toast('تم اعادة فتح العميل', 'success');
            await load(); render();
    }

    function scheduleFollowup(c) {
            const dateInput = el('input', { type: 'datetime-local' });
            const reasonInput = el('input', { placeholder: 'السبب (اختياري)' });
            const notesInput = el('textarea', { placeholder: 'ملاحظات (اختياري)' });
            const body = el('div', {}, [
                      el('div', { class: 'field' }, [el('label', {}, ['التاريخ والوقت']), dateInput]),
                      el('div', { class: 'field' }, [el('label', {}, ['السبب']), reasonInput]),
                      el('div', { class: 'field' }, [el('label', {}, ['ملاحظات']), notesInput]),
                    ]);
            const dlg = modal('جدولة متابعة', body, []);
            dlg.el.querySelector('.modal-footer').append(
                      el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['الغاء']),
                      el('button', { class: 'btn btn-primary', onclick: async () => {
                                  if (!dateInput.value) { toast('اختر التاريخ والوقت', 'error'); return; }
                                  await api('/followups/customers/' + c.id, { method: 'POST', body: { scheduledFor: new Date(dateInput.value).toISOString(), reason: reasonInput.value, notes: notesInput.value } });
                                  toast('تم جدولة المتابعة', 'success');
                                  dlg.close(); await load(); render();
                      } }, ['جدولة'])
                    );
    }

    async function openWhatsAppModal(c, skipConfirm) {
            let preview;
            try { preview = await api('/whatsapp/customers/' + c.id + '/preview'); }
            catch (e) { toast(e.message, 'error'); return; }
            if (!preview.phoneValid) {
                      const dlg = modal('واتساب', el('div', {}, ['رقم الهاتف غير صالح.']), []);
                      dlg.el.querySelector('.modal-footer').append(
                                  el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['الغاء']),
                                  el('button', { class: 'btn btn-outline', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(c.phone); toast('تم نسخ الرقم', 'success'); } }, ['نسخ الرقم'])
                                );
                      return;
            }
            async function showComposer() {
                      if (!skipConfirm && c.whatsappContactStatus !== 'NOT_CONTACTED') {
                                  const proceed = confirm('تم التواصل مع هذا العميل مسبقا. هل تريد فتح واتساب مرة اخرى؟');
                                  if (!proceed) return;
                      }
                      let originalMessage = preview.message;
                      const textarea = el('textarea', { style: 'min-height:160px' }, [originalMessage]);
                      textarea.value = originalMessage;
                      let templatePicker = null;
                      if (Array.isArray(preview.templates) && preview.templates.length) {
                                  const chips = preview.templates.map((t, i) => el('button', { type: 'button', class: 'btn btn-outline btn-sm' + (i === 0 ? ' active' : ''), style: 'margin:0 0 6px 6px', onclick: () => { originalMessage = t.message; textarea.value = t.message; chips.forEach((b, j) => { b.style.background = j === i ? 'var(--primary,#2563eb)' : ''; b.style.color = j === i ? '#fff' : ''; }); } }, [t.label]));
                                  originalMessage = preview.templates[0].message; textarea.value = originalMessage;
                                  chips[0].style.background = 'var(--primary,#2563eb)'; chips[0].style.color = '#fff';
                                  templatePicker = el('div', { class: 'field' }, [el('label', {}, ['اختاري قالب الرسالة']), el('div', {}, chips)]);
                      }
                      const body = el('div', {}, [
                                  el('div', { class: 'mb-8', style: 'font-size:13px' }, [el('b', {}, ['العميل: ']), c.name || '—', ' — ', el('span', { class: 'mono' }, [c.phone])]),
                                  el('div', { class: 'mb-12', style: 'font-size:13px' }, [el('b', {}, ['الموظف: ']), App.state.user.displayName]),
                                  ...(templatePicker ? [templatePicker] : []),
                                  el('div', { class: 'field' }, [el('label', {}, ['الرسالة المقترحة']), textarea]),
                                  el('button', { class: 'link-btn', onclick: () => { textarea.value = originalMessage; } }, ['اعادة الرسالة الافتراضية']),
                                ]);
                      const dlg = modal('التواصل عبر واتساب', body, []);
                      dlg.el.querySelector('.modal-footer').append(
                                  el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['الغاء']),
                                  el('button', { class: 'btn btn-whatsapp', onclick: async () => {
                                                try { const res = await api('/whatsapp/customers/' + c.id + '/initiate', { method: 'POST', body: { message: textarea.value } }); window.open(res.url, '_blank'); toast('تم بدء التواصل عبر واتساب', 'success'); dlg.close(); await load(); render(); }
                                                catch (e) { toast(e.message, 'error'); }
                                  } }, ['فتح واتساب'])
                                );
            }
            await showComposer();
    }

    async function openWhatsAppModal(c, skipConfirm) {
            let preview;
            try { preview = await api('/whatsapp/customers/' + c.id + '/preview'); }
            catch (e) { toast(e.message, 'error'); return; }
            if (!preview.phoneValid) {
                      const dlg = modal('واتساب', el('div', {}, ['رقم الهاتف غير صالح.']), []);
                      dlg.el.querySelector('.modal-footer').append(
                                  el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['الغاء']),
                                  el('button', { class: 'btn btn-outline', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(c.phone); toast('تم نسخ الرقم', 'success'); } }, ['نسخ الرقم'])
                                );
                      return;
            }
            async function showComposer() {
                                            if (!skipConfirm && c.whatsappContactStatus !== 'NOT_CONTACTED') {
                                                        if (!confirm('تم التواصل مع هذا العميل مسبقا. هل تريد المتابعة؟')) return;
                                            }
                      let originalMessage = preview.message;
                      const textarea = el('textarea', { style: 'min-height:160px' }, [originalMessage]);
                      textarea.value = originalMessage;
                      const body = el('div', {}, [
                                  el('div', { class: 'mb-8', style: 'font-size:13px' }, [el('b', {}, ['العميل: ']), c.name || '—']),
                                  el('div', { class: 'field' }, [el('label', {}, ['الرسالة المقترحة']), textarea]),
                                  el('button', { class: 'link-btn', onclick: () => { textarea.value = originalMessage; } }, ['اعادة الرسالة الافتراضية']),
                                ]);
                      const dlg = modal('التواصل عبر واتساب', body, []);
                      dlg.el.querySelector('.modal-footer').append(
                                  el('button', { class: 'btn btn-outline', onclick: () => dlg.close() }, ['الغاء']),
                                  el('button', { class: 'btn btn-whatsapp', onclick: async () => {
                                                try {
                                                                const res = await api('/whatsapp/customers/' + c.id + '/initiate', { method: 'POST', body: { message: textarea.value } });
                                                                window.open(res.url, '_blank');
                                                                toast('تم بدء التواصل عبر واتساب', 'success');
                                                                dlg.close(); await load(); render();
                                                } catch (e) { toast(e.message, 'error'); }
                                  } }, ['فتح واتساب'])
                                );
            }
            await showComposer();
    }
}

    function renderFollowups() {
            if (data.followups.length === 0) return el('div', { class: 'empty-state' }, ['لا توجد متابعات مجدولة.']);
            return el('div', { class: 'table-wrap' }, [
                      el('table', { class: 'data-table' }, [
                                  el('thead', {}, [el('tr', {}, ['الموعد', 'السبب', 'الحالة', ''].map((h) => el('th', {}, [h])))]),
                                  el('tbody', {}, data.followups.map((f) => el('tr', {}, [
                                                el('td', {}, [fmt.dateTime(f.scheduled_for)]),
                                                el('td', {}, [f.reason || '—']),
                                                el('td', {}, [FOLLOWUP_STATUS_LABELS[f.status] || f.status]),
                                                el('td', {}, [f.status === 'UPCOMING' || f.status === 'OVERDUE' ? el('button', { class: 'btn btn-sm btn-success', onclick: async () => { await api('/followups/' + f.id + '/complete', { method: 'POST' }); await load(); render(); } }, ['انجاز']) : '']),
                                              ]))),
                                ]),
                    ]);
    }

    function renderTimeline() {
            if (data.timeline.length === 0) return el('div', { class: 'empty-state' }, ['لا يوجد نشاط بعد.']);
            return el('div', { class: 'timeline' }, data.timeline.map((t) =>
                      el('div', { class: 'timeline-item' }, [
                                  el('div', { class: 'timeline-time' }, [fmt.dateTime(t.created_at)]),
                                  el('div', { class: 'timeline-text' }, [(t.actor_name || 'النظام') + ' — ' + describeAction(t)]),
                                ])
                                                                            ));
    }

    function describeAction(t) {
            const meta = t.metadata ? JSON.parse(t.metadata) : {};
            switch (t.action) {
              case 'CUSTOMER_CREATED': return 'تم انشاء العميل';
              case 'STATUS_CHANGED': return 'تغيير الحالة ' + (STATUS_LABELS[meta.from] || meta.from) + ' - ' + (STATUS_LABELS[meta.to] || meta.to);
              case 'NOTE_ADDED': return 'تمت اضافة ملاحظة';
              case 'CALL_INITIATED': return 'تم بدء اتصال';
              case 'WHATSAPP_CONTACT_INITIATED': return 'تم بدء التواصل عبر واتساب';
              case 'FOLLOWUP_CREATED': return 'تم جدولة متابعة';
              case 'FOLLOWUP_COMPLETED': return 'تم انجاز المتابعة';
              case 'CUSTOMER_REOPENED': return 'تم اعادة فتح العميل';
              case 'PRIORITY_CHANGED': return 'تغيير الاولوية ' + meta.from + ' - ' + meta.to;
              case 'CALL_ATTEMPT_CREATED': return 'تم تسجيل محاولة اتصال';
              case 'BRANCH_VISIT_CREATED': return 'زيارة فرع — ' + (meta.branchName || '');
              case 'DEAL_DONE_CREATED': return 'تمت الصفقة — ' + (meta.amount ? meta.amount + ' ج.م' : '') + ' في ' + (meta.branchName || '');
              case 'PURCHASE_UPDATED': return 'تم تعديل تفاصيل الشراء';
              case 'PURCHASE_CANCELLED': return 'تم ابطال الشراء' + (meta.reason ? ' — ' + meta.reason : '');
              case 'REFUND_CREATED': return 'تم تسجيل استرجاع — ' + (meta.amount || '') + (meta.reason ? ' — ' + meta.reason : '');
              case 'ATTRIBUTION_CHANGED': return 'تم اعادة نسب الصفقة';
              case 'COMPLAINT_LOGGED': return 'تم تسجيل شكوى';
              case 'CUSTOMER_MARKED_VIP': return 'تم تمييز العميل كـ VIP';
              case 'CUSTOMER_UNMARKED_VIP': return 'تم الغاء تمييز VIP';
              default: return t.action.replace(/_/g, ' ').toLowerCase();
            }
    }

    render();
    const off = App.onRealtime(async () => { await load(); render(); }, 4000);
    container.cleanup = () => { off(); App.clearNoteGuard(); };
    return container;
});
})();
