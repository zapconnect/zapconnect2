// public/js/fluxos-visual.js
(() => {
  let editor = null;
  let currentFlow = null;
  let nodePropsContent = null;
  const nodeDefaults = {
    start: { label: "Start", outputs: 1, payload: {} },
    send_text: { label: "Texto", outputs: 1, payload: "Digite a mensagem" },
    delay: { label: "Delay", outputs: 1, payload: 2 },
    send_media: { label: "Mídia", outputs: 1, payload: "data:..." },
    update_crm: { label: "Atualizar CRM", outputs: 1, payload: { stage: "", tag: "", note: "" } },
    call_webhook: { label: "Webhook", outputs: 1, payload: { url: "", headers: {}, timeout_ms: 8000 } },
    branch: { label: "Branch", outputs: 2, payload: { condition: { contains: "" } } },
  };

  function init() {
    const btnVisual = document.getElementById("btnVisualFlow");
    const visualModal = document.getElementById("visualModal");
    const visualClose = document.getElementById("visualClose");
    const visualApply = document.getElementById("visualApply");
    nodePropsContent = document.getElementById("nodePropsContent");

    btnVisual?.addEventListener("click", () => {
      openVisual(null);
    });
    visualClose?.addEventListener("click", () => visualModal.style.display = "none");
    visualApply?.addEventListener("click", applyToForm);

    // Palette drag
    document.querySelectorAll('.draggable-node').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('node-type', el.dataset.type);
      });
    });

    // Drawflow setup
    const wrapper = document.getElementById('drawflow-wrapper');
    const dfEl = document.getElementById('drawflow');
    editor = new Drawflow(dfEl);
    editor.reroute = true;
    editor.start();

    wrapper?.addEventListener('dragover', (ev) => ev.preventDefault());
    wrapper?.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const type = ev.dataTransfer.getData('node-type');
      if (!type) return;
      const pos = editor.editor.getBoundingClientRect();
      const x = ev.clientX - pos.x;
      const y = ev.clientY - pos.y;
      addNode(type, x, y);
    });

    editor.on('nodeSelected', (id) => renderProps(id));
    editor.on('nodeMoved', () => {});
  }

  function addNode(type, x, y) {
    const def = nodeDefaults[type];
    if (!def) return;
    const data = JSON.parse(JSON.stringify(def.payload));
    const html = `<div class="df-node">${def.label}</div>`;
    editor.addNode(type, 0, def.outputs, x, y, type, data, html);
  }

  function renderProps(id) {
    const node = editor.getNodeFromId(id);
    if (!node) {
      nodePropsContent.innerHTML = "Selecione um bloco.";
      return;
    }
    const type = node.name;
    const data = node.data || {};
    let html = `<div style="display:flex;flex-direction:column;gap:6px;">`;
    html += `<div><strong>Tipo:</strong> ${type}</div>`;
    function input(name, value, placeholder = "") {
      return `<label style='font-size:12px;color:#cbd5e1'>${name}</label><input data-prop="${name}" value="${value ?? ''}" style='width:100%;padding:6px;border-radius:6px;border:1px solid #1f2937;background:#0b1224;color:#e2e8f0;' placeholder='${placeholder}'>`;
    }
    if (type === 'send_text') {
      html += input('payload', data || '', 'Mensagem');
    } else if (type === 'delay') {
      html += input('payload', data || 2, 'Segundos');
    } else if (type === 'send_media') {
      html += input('payload', data || '', 'data:...');
    } else if (type === 'update_crm') {
      html += input('stage', data.stage || '', 'ex: Qualificado');
      html += input('tag', data.tag || '', 'ex: vip');
      html += input('note', data.note || '', 'ex: lead quente');
    } else if (type === 'call_webhook') {
      html += input('url', data.url || '', 'https://...');
      html += input('timeout_ms', data.timeout_ms || 8000, 'ms');
      html += `<label style='font-size:12px;color:#cbd5e1'>headers (JSON)</label><textarea data-prop="headers" style='width:100%;height:80px;padding:6px;border-radius:6px;border:1px solid #1f2937;background:#0b1224;color:#e2e8f0;'>${JSON.stringify(data.headers || {})}</textarea>`;
    } else if (type === 'branch') {
      const cond = data.condition || { contains: '' };
      html += input('contains', Array.isArray(cond.contains) ? cond.contains.join(',') : cond.contains || '', 'palavras separadas por vírgula');
    }
    html += `</div>`;
    nodePropsContent.innerHTML = html;

    nodePropsContent.querySelectorAll('[data-prop]').forEach((el) => {
      el.addEventListener('input', () => {
        const prop = el.dataset.prop;
        let val = el.value;
        if (prop === 'payload' && type === 'delay') val = Number(val) || 1;
        if (type === 'update_crm') {
          node.data = { ...node.data, [prop]: val };
        } else if (type === 'call_webhook') {
          if (prop === 'headers') {
            try { node.data.headers = JSON.parse(val || '{}'); } catch { }
          } else if (prop === 'timeout_ms') {
            node.data.timeout_ms = Number(val) || 8000;
          } else {
            node.data.url = val;
          }
        } else if (type === 'branch') {
          const list = val.split(',').map(s => s.trim()).filter(Boolean);
          node.data.condition = { contains: list.length ? list : '' };
        } else {
          node.data = (prop === 'payload') ? val : { ...node.data, [prop]: val };
        }
        editor.updateNodeDataFromId(node.id, node.data);
      });
    });
  }

  function graphToActions() {
    const exportData = editor.export();
    const nodes = exportData.drawflow?.Home?.data || {};
    const startEntry = Object.values(nodes).find((n) => n.name === 'start');
    if (!startEntry) return [];

    const visit = (nodeId) => {
      const n = nodes[nodeId];
      if (!n) return [];
      const t = n.name;
      const actions = [];
      if (t === 'send_text') actions.push({ type: 'send_text', payload: n.data });
      else if (t === 'delay') actions.push({ type: 'delay', payload: Number(n.data) || 1 });
      else if (t === 'send_media') actions.push({ type: 'send_media', payload: n.data });
      else if (t === 'update_crm') actions.push({ type: 'update_crm', payload: n.data });
      else if (t === 'call_webhook') actions.push({ type: 'call_webhook', payload: n.data });
      else if (t === 'branch') {
        const outs = n.outputs || {};
        const thenNext = outs['output_1']?.connections?.[0]?.node;
        const elseNext = outs['output_2']?.connections?.[0]?.node;
        actions.push({
          type: 'branch',
          condition: n.data?.condition || { contains: '' },
          then: thenNext ? visit(thenNext) : [],
          else: elseNext ? visit(elseNext) : [],
        });
        return actions;
      }
      const nextId = n.outputs?.output_1?.connections?.[0]?.node;
      if (nextId) actions.push(...visit(nextId));
      return actions;
    };

    return visit(startEntry.id);
  }

  function actionsToGraph(actions) {
    editor.clear();
    let y = 50;
    const centerX = 200;
    const startId = editor.addNode('start', 0, 1, centerX, y, 'start', {}, `<div class="df-node">Start</div>`);
    const stack = [[actions, startId]];

    while (stack.length) {
      const [acts, parent] = stack.pop();
      let currentParent = parent;
      for (const act of acts) {
        y += 80;
        const def = nodeDefaults[act.type];
        if (!def) continue;
        if (act.type === 'branch') {
          const nodeId = editor.addNode('branch', 0, 2, centerX, y, 'branch', { condition: act.condition }, `<div class="df-node">Branch</div>`);
          editor.addConnection(currentParent, nodeId, 'output_1', 'input_1');
          currentParent = null;
          if (act.then?.length) stack.push([act.then, nodeId]);
          if (act.else?.length) stack.push([act.else, nodeId]);
        } else {
          const nodeId = editor.addNode(act.type, 0, 1, centerX, y, act.type, act.payload ?? act, `<div class="df-node">${def.label}</div>`);
          editor.addConnection(currentParent, nodeId, 'output_1', 'input_1');
          currentParent = nodeId;
        }
      }
    }
  }

  function openVisual(flow) {
    currentFlow = flow;
    const visualModal = document.getElementById("visualModal");
    const title = document.getElementById("visualTitle");
    title.textContent = flow ? `Editor Visual - ${flow.name}` : "Editor Visual";
    visualModal.style.display = "flex";
    setTimeout(() => editor?.zoom_reset(), 50);
    const acts = flow ? JSON.parse(flow.actions || "[]") : [];
    actionsToGraph(acts);
  }

  async function applyToForm() {
    if (!currentFlow) return alert("Abra um fluxo para aplicar");
    const actions = graphToActions();
    if (!actions.length) return alert("Fluxo visual vazio");
    const evt = new CustomEvent('visualFlowUpdate', { detail: { id: currentFlow.id, actions } });
    window.dispatchEvent(evt);
    document.getElementById('visualModal').style.display = 'none';
  }

  window.openVisualEditorFor = function(flow){
    openVisual(flow);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
