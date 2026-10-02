(() => {
  const localName = (node) => node?.localName || node?.nodeName?.split(":").pop();
  const textEncoder = new TextEncoder();
  const cteNamespace = "http://www.portalfiscal.inf.br/cte";
  const mdfeNamespace = "http://www.portalfiscal.inf.br/mdfe";
  let apiBaseUrl = "";
  let sessionToken = sessionStorage.getItem("oficina-xml.session.v1") || "";
  let sharedRefreshTimer;
  let activeDocumentId = null;
  let activeDocumentCreatedAt = null;
  let assignedNumber = null;
  let isSavingDocument = false;
  let loadingDocument = false;
  let isDirty = false;
  let autoSaveTimer;
  const profileSaveTimers = new WeakMap();
  const catalog = loadCatalog();

  async function apiRequest(path, options = {}) {
    const response = await fetch(`${apiBaseUrl}/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...options.headers
      }
    });
    const body = await response.text();
    let result = {};
    if (body.trim()) {
      try { result = JSON.parse(body); }
      catch { throw new Error(`A API retornou uma resposta inválida (HTTP ${response.status}).`); }
    }
    if (!response.ok) throw new Error(result.error || `Falha na API (HTTP ${response.status}).`);
    return result;
  }

  async function createLoginProof(password, challenge) {
    if (!/^[a-f0-9]{32}$/.test(challenge.salt) || !/^[a-f0-9]{64}$/.test(challenge.challengeId) ||
      !Number.isSafeInteger(challenge.iterations) || challenge.iterations < 100_000 || challenge.iterations > 1_000_000) {
      throw new Error("A API retornou um desafio de autenticação inválido.");
    }
    const passwordKey = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const verifier = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt: Uint8Array.from(challenge.salt.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)),
      iterations: challenge.iterations,
      hash: "SHA-256"
    }, passwordKey, 256);
    const proofKey = await crypto.subtle.importKey("raw", verifier, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const proof = await crypto.subtle.sign("HMAC", proofKey, textEncoder.encode(challenge.challengeId));
    return [...new Uint8Array(proof)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function getAllRecords(name) {
    return apiRequest(`/${name}`);
  }

  function getRecord(name, id) {
    return apiRequest(`/${name}/${encodeURIComponent(id)}`);
  }

  async function refreshSharedData() {
    const [profiles, references] = await Promise.all([getAllRecords("profiles"), getAllRecords("references")]);
    ["emitters", "senders", "recipients", "vehicles"].forEach((name) => {
      catalog[name] = profiles.filter((profile) => profile.type === name);
    });
    catalog.references = references;
    catalog.selected = catalog.selected.filter((id) => references.some((item) => item.id === id));
    refreshProfileSelects();
    renderReferences();
  }

  function subscribeToSharedChanges() {
    clearInterval(sharedRefreshTimer);
    sharedRefreshTimer = setInterval(async () => {
      if (!sessionToken || document.hidden) return;
      try {
        await refreshSharedData();
        await Promise.all([renderDocumentLibrary(), renderProductCatalog()]);
      } catch (error) {
        document.getElementById("database-status").textContent = "Falha de sincronização";
        document.getElementById("database-status").dataset.state = "error";
        feedback(`Não foi possível sincronizar os dados compartilhados: ${error.message}`, "error");
      }
    }, 15000);
  }

  function getAllDocuments() {
    return getAllRecords("documents");
  }

  function loadCatalog() {
    return { emitters: [], senders: [], recipients: [], vehicles: [], references: [], selected: [] };
  }

  async function persistCatalog(references) {
    if (references.length) await apiRequest("/references", { method: "POST", body: JSON.stringify({ references }) });
  }

  const panel = document.createElement("section");
  panel.className = "offline-tools";
  panel.setAttribute("aria-label", "Cadastros e validações locais");
  panel.innerHTML = `
    <div class="workflow-header">
      <div><p class="eyebrow">Oficina fiscal · espaço compartilhado</p><h2>Montar documento de teste</h2><p>Rascunhos, cadastros e produtos sincronizados pelo banco D1 para toda a equipe autorizada.</p></div>
      <div class="workflow-header-actions"><span class="layout-badge" id="layout-badge">Leiaute</span><span id="main-actions-slot"></span></div>
    </div>
    <section class="cloud-auth" id="cloud-auth" aria-labelledby="cloud-auth-title">
      <div class="cloud-auth-copy"><p class="section-label">Banco compartilhado</p><h3 id="cloud-auth-title">Conectar ao espaço de testes</h3><p>Entre com a conta cadastrada pelo administrador. Documentos, cadastros e produtos ficam no banco D1 compartilhado.</p><p class="cloud-auth-help" id="cloud-auth-help" role="status">Configure a URL da API em <code>cloudflare-config.js</code> e implante a API conforme <code>CLOUDFLARE_SETUP.md</code>.</p></div>
      <form id="cloud-login-form" class="cloud-login-form">
        <label>E-mail<input name="email" type="email" autocomplete="username" required></label>
        <label>Senha<input name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required></label>
        <button class="primary" type="submit" id="cloud-login-button">Entrar no banco</button>
      </form>
      <div class="cloud-session" id="cloud-session" hidden><span id="cloud-user-email"></span><button class="tool-button" type="button" id="cloud-logout">Sair</button></div>
    </section>
    <div id="cloud-app" hidden>
    <section class="document-library" aria-labelledby="library-title">
      <div class="library-heading">
        <div><p class="section-label">Arquivo compartilhado</p><h3 id="library-title">Documentos de teste</h3><p id="library-summary">Conecte-se para carregar os documentos…</p></div>
        <button class="tool-button primary-tool" id="new-document" type="button">+ Novo documento</button>
      </div>
      <div class="library-tools"><label>Buscar por número, participante ou tipo<input id="document-search" type="search" placeholder="Ex.: NF-e, 000001 ou cliente" autocomplete="off"></label><span class="database-status" id="database-status" role="status">Banco D1</span></div>
      <div class="document-list" id="document-list" aria-live="polite"></div>
      <section class="product-catalog" aria-labelledby="product-catalog-title">
        <div class="catalog-heading"><div><p class="section-label">Reutilização rápida</p><h4 id="product-catalog-title">Produtos salvos</h4><p>Produtos válidos entram aqui ao salvar o documento. Pesquise e insira sem redigitar.</p></div><span class="catalog-count" id="product-catalog-count">Carregando…</span></div>
        <label class="catalog-search">Pesquisar produtos<input id="product-catalog-search" type="search" placeholder="Descrição ou NCM" autocomplete="off"></label>
        <div class="saved-product-list" id="saved-product-list" aria-live="polite"></div>
      </section>
    </section>
    <nav class="workflow-steps" aria-label="Etapas do documento">
      <button type="button" class="workflow-step current" data-workflow-step="1" aria-current="step"><span>01</span> Documento e cadastros</button>
      <button type="button" class="workflow-step" data-workflow-step="2"><span>02</span> Dados e vínculos</button>
      <button type="button" class="workflow-step" data-workflow-step="3"><span>03</span> Validar e imprimir</button>
    </nav>
    <section class="workflow-stage" data-stage="1">
      <div class="stage-heading"><div><p class="section-label">Documento</p><h3>Escolha o tipo e os participantes</h3></div><div id="type-selector-slot"></div></div>
      <div class="profile-grid">
        ${profileGroup("Emitente", "emitters", "emit")}
        ${profileGroup("Remetente", "senders", "rem")}
        ${profileGroup("Destinatário / cliente", "recipients", "dest")}
        <div class="profile-group" data-group="vehicles" data-document-types="cte,mdfe">
          <h3>Veículo / motorista</h3>
          <label>Placa<input name="plate" value="XXX0X00" autocomplete="off"></label>
          <label>RNTRC<input name="rntrc" value="00000000" autocomplete="off"></label>
          <label>Motorista<input name="driver" value="MOTORISTA FICTICIO" autocomplete="off"></label>
          ${profileSelect("vehicles", "veículo")}
          <button class="tool-button save-profile" type="button">Salvar veículo</button><span class="profile-save-status" role="status"></span>
        </div>
      </div>
      <footer class="stage-footer"><span>Alterações sincronizadas com o banco após a pausa na digitação.</span><button class="primary" type="button" data-next-step="2">Continuar para os dados <span aria-hidden="true">→</span></button></footer>
    </section>
    <section class="workflow-stage" data-stage="2" hidden>
      <div class="stage-heading"><div><p class="section-label">Dados da emissão</p><h3 id="emission-heading">Dados da operação</h3><p class="stage-description" id="emission-description"></p></div><span class="api-status" id="ibge-status">Conectando ao IBGE…</span></div>
      <div class="doc-fields">
        <label data-document-types="nfe,cte">Natureza da operação<input name="nature" value="VENDA DE MERCADORIA - TESTE"></label>
        <section class="product-editor" data-document-types="nfe" aria-labelledby="products-title">
          <div class="product-editor-heading"><div><strong id="products-title">Produtos da nota</strong><small>Adicione cada item com descrição, NCM, quantidade e valor unitário.</small></div><button class="tool-button" id="add-product" type="button">+ Adicionar produto</button></div>
          <div id="product-list"></div>
          <div class="product-total">Total dos produtos <strong id="products-total">R$ 0,00</strong></div>
        </section>
        <label data-document-types="cte">Descrição predominante da carga<input name="cargoDescription" value="VOLUME FICTICIO"></label>
        <label data-document-types="nfe,cte">CFOP<input name="cfop" value="5102" inputmode="numeric"></label>
        <label data-document-types="cte,mdfe,nfse" data-label-cte="Valor do frete" data-label-mdfe="Valor da carga" data-label-nfse="Valor do serviço">Valor da operação<input name="amount" value="250.00" inputmode="decimal"></label>
        <label data-document-types="nfse">Descrição do serviço<input name="serviceDescription" value="SERVICO FICTICIO PARA TESTE - SEM PRESTACAO REAL"></label>
        <label data-document-types="nfse">Data de competência<input name="competence" type="date"></label>
        <label data-document-types="cte,mdfe,nfse">UF de início / prestação<select name="originUf" data-city-side="origin"><option value="SP">SP</option></select></label>
        <label data-document-types="cte,mdfe,nfse">Município de início / prestação<select name="originCode" data-city-side="origin"><option value="3550308">São Paulo</option></select></label>
        <input type="hidden" name="originName" value="SAO PAULO">
        <label data-document-types="cte,mdfe">UF de destino<select name="destinationUf" data-city-side="destination"><option value="RJ">RJ</option></select></label>
        <label data-document-types="cte,mdfe">Município de destino<select name="destinationCode" data-city-side="destination"><option value="3304557">Rio de Janeiro</option></select></label>
        <input type="hidden" name="destinationName" value="RIO DE JANEIRO">
      </div>
      <div class="ref-row">
        <div><strong>Documentos vinculados</strong><small id="reference-hint">Os tipos permitidos dependem do documento que está sendo montado.</small></div>
        <div class="ref-actions"><label class="tool-button" for="reference-files">Adicionar XMLs</label><input id="reference-files" type="file" accept=".xml,text/xml,application/xml" multiple hidden></div>
      </div>
      <div class="reference-list" id="reference-list" aria-label="XMLs importados"></div>
      <div class="stage-footer stage-footer-split"><button class="tool-button" type="button" data-next-step="1">← Voltar</button><button class="primary" type="button" data-next-step="3">Revisar documento <span aria-hidden="true">→</span></button></div>
    </section>
    <section class="workflow-stage" data-stage="3" hidden>
      <div class="stage-heading"><div><p class="section-label">Conferência local</p><h3>Validar, revisar e exportar</h3></div><button class="tool-button" type="button" data-next-step="2">← Voltar aos dados</button></div>
      <div class="review-toolbar"><button class="tool-button primary-tool" id="validate-schema" type="button">Validar no XSD</button><button class="tool-button" id="download-final-xml" type="button">Baixar XML</button><button class="tool-button" id="print-preview" type="button">Prévia de impressão</button></div>
      <div class="tool-feedback" id="tool-feedback" role="status" aria-live="polite">XSD oficial local para CT-e e MDF-e. Regras não estruturais e validação da SEFAZ não são executadas.</div>
      <div id="xml-preview-slot"></div>
      <p class="review-note">A folha impressa é uma representação de teste, não substitui DANFE, DACTE, DAMDFE ou DANFSe oficial. Use o diálogo do navegador para salvar em PDF.</p>
      <footer class="final-actions"><span>Confira os dados e a prévia antes de salvar o rascunho.</span><span id="final-actions-slot"></span></footer>
    </section>`;
  panel.insertAdjacentHTML("beforeend", "</div>");

  function profileGroup(title, listName, xmlRole) {
    const types = listName === "senders" ? "cte" : listName === "recipients" ? "nfe,cte,nfse" : "all";
    return `<div class="profile-group" data-group="${listName}" data-xml-role="${xmlRole}" data-document-types="${types}"><h3>${title}</h3><label>CNPJ<input name="cnpj" value="00000000000000" inputmode="numeric" autocomplete="off"></label><label>Razão social<input name="name" value="${title.toUpperCase()} FICTICIO TESTE" autocomplete="organization"></label>${profileSelect(listName, title.toLowerCase())}<button class="tool-button save-profile" type="button">Salvar ${title.toLowerCase()}</button><span class="profile-save-status" role="status"></span></div>`;
  }

  function profileSelect(listName, label) {
    return `<label class="profile-select">Pesquisar cadastro salvo<input data-profile-search="${listName}" type="search" placeholder="Nome, CNPJ ou placa" autocomplete="off"></label><label>Selecionar cadastro<select data-list="${listName}" aria-label="Selecionar ${label} salvo"><option value="">Sem cadastro salvo</option></select></label>`;
  }

  function feedback(message, state = "ok", details = []) {
    const target = document.getElementById("tool-feedback");
    if (!target) return;
    target.dataset.state = state;
    target.replaceChildren(document.createTextNode(message));
    if (details.length) {
      const list = document.createElement("ul");
      details.forEach((detail) => {
        const item = document.createElement("li");
        item.textContent = detail;
        list.append(item);
      });
      target.append(list);
    }
  }

  function getProducts() {
    return [...panel.querySelectorAll(".product-row")].map((row) => ({
      description: row.querySelector('[name="productDescription"]').value.trim(),
      ncm: row.querySelector('[name="productNcm"]').value.trim(),
      quantity: row.querySelector('[name="productQuantity"]').value.trim(),
      unitPrice: row.querySelector('[name="productUnitPrice"]').value.trim()
    }));
  }

  function productCatalogId(product) {
    return encodeURIComponent(`${product.description.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR")}|${product.ncm.trim()}`);
  }

  function renderProductCatalog() {
    const list = panel.querySelector("#saved-product-list");
    const search = panel.querySelector("#product-catalog-search").value.trim().toLocaleLowerCase("pt-BR");
    if (!apiBaseUrl || !sessionToken) {
      list.textContent = "Entre para consultar os produtos compartilhados.";
      return;
    }
    getAllRecords("products").then((products) => {
      products.sort((left, right) => left.description.localeCompare(right.description, "pt-BR"));
      panel.querySelector("#product-catalog-count").textContent = `${products.length} produto(s)`;
      const visible = products.filter((product) => `${product.description} ${product.ncm}`.toLocaleLowerCase("pt-BR").includes(search));
      list.replaceChildren();
      if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "catalog-empty";
        empty.textContent = products.length ? "Nenhum produto corresponde à busca." : "Seu catálogo será preenchido automaticamente ao salvar documentos com produtos válidos.";
        list.append(empty);
        return;
      }
      visible.slice(0, 12).forEach((product) => {
        const item = document.createElement("article");
        item.className = "saved-product";
        const details = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = product.description;
        const meta = document.createElement("span");
        meta.textContent = `NCM ${product.ncm} · ${Number(product.unitPrice).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`;
        details.append(name, meta);
        const use = document.createElement("button");
        use.type = "button";
        use.className = "tool-button";
        use.dataset.productId = product.id;
        use.textContent = "Adicionar";
        item.append(details, use);
        list.append(item);
      });
      if (visible.length > 12) {
        const more = document.createElement("p");
        more.className = "catalog-empty";
        more.textContent = `Mostrando 12 de ${visible.length}. Refine a busca para localizar outros.`;
        list.append(more);
      }
    }).catch((error) => {
      feedback(`Falha ao carregar produtos salvos: ${error.message}`, "error");
    });
  }

  function addCatalogProduct(product) {
    const products = getProducts();
    const first = products.length === 1 && !products[0].description && !products[0].ncm && !products[0].unitPrice;
    if (first) products[0] = { ...product, quantity: "1" };
    else products.push({ ...product, quantity: "1" });
    renderProducts(products);
    isDirty = true;
    scheduleAutoSave();
    refreshDocument();
  }

  function renderProducts(products) {
    const list = panel.querySelector("#product-list");
    if (!list) return;
    list.replaceChildren();
    (products.length ? products : [{ description: "", ncm: "", quantity: "1", unitPrice: "" }]).forEach((product, index) => {
      const row = document.createElement("div");
      row.className = "product-row";
      const title = document.createElement("span");
      title.className = "product-index";
      title.textContent = `Item ${String(index + 1).padStart(2, "0")}`;
      row.append(title);
      [
        ["productDescription", "Descrição do produto", product.description, "text"],
        ["productNcm", "NCM (8 dígitos)", product.ncm, "text"],
        ["productQuantity", "Quantidade", product.quantity || "1", "number"],
        ["productUnitPrice", "Valor unitário (R$)", product.unitPrice, "text"]
      ].forEach(([name, labelText, value, type]) => {
        const label = document.createElement("label");
        label.textContent = labelText;
        const input = document.createElement("input");
        input.name = name;
        input.type = type;
        input.value = value;
        input.autocomplete = "off";
        if (name === "productDescription") input.maxLength = 120;
        if (name === "productNcm") {
          input.inputMode = "numeric";
          input.maxLength = 8;
          input.pattern = "[0-9]{8}";
        }
        if (name === "productQuantity") {
          input.min = "0.0001";
          input.step = "0.0001";
        }
        label.append(input);
        row.append(label);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-product";
      remove.textContent = "Remover";
      remove.setAttribute("aria-label", `Remover item ${index + 1}`);
      remove.disabled = products.length <= 1;
      row.append(remove);
      list.append(row);
    });
    updateProductsTotal();
  }

  function updateProductsTotal() {
    const total = getProducts().reduce((sum, item) => sum + parseQuantity(item.quantity) * parseAmount(item.unitPrice), 0);
    const output = panel.querySelector("#products-total");
    if (output) output.textContent = total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function validateProducts() {
    const products = getProducts();
    const invalid = products.findIndex((product) =>
      !product.description || !/^\d{8}$/.test(product.ncm) ||
      !(parseQuantity(product.quantity) > 0) || !(parseAmount(product.unitPrice) >= 0) || !product.unitPrice
    );
    if (invalid < 0) return true;
    const row = panel.querySelectorAll(".product-row")[invalid];
    feedback(`Confira o item ${invalid + 1}: informe descrição, NCM com 8 dígitos, quantidade maior que zero e valor unitário.`, "error");
    row?.querySelector('[name="productNcm"]').focus();
    return false;
  }

  function productsAreValid() {
    return getProducts().every((product) =>
      product.description && /^\d{8}$/.test(product.ncm) &&
      parseQuantity(product.quantity) > 0 && parseAmount(product.unitPrice) >= 0 && product.unitPrice
    );
  }

  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    const status = document.getElementById("database-status");
    status.textContent = "Alterações pendentes · salvando automaticamente…";
    status.dataset.state = "pending";
    autoSaveTimer = setTimeout(() => {
      if (currentType() === "nfe" && !productsAreValid()) {
        status.textContent = "Preencha os produtos para salvar automaticamente";
        status.dataset.state = "pending";
        return;
      }
      saveCurrentDocument(true);
    }, 1000);
  }

  function captureDocumentData() {
    const fields = [...panel.querySelectorAll(".profile-group input, .doc-fields input, .doc-fields select")]
      .filter((input) => input.name && !input.closest(".product-row"));
    const data = Object.fromEntries(fields
      .map((input) => [`${input.closest(".profile-group")?.dataset.group || "operation"}.${input.name}`, input.value]));
    data.products = getProducts();
    return data;
  }

  function documentDescription() {
    const title = document.getElementById("document-title").textContent;
    const details = captureDocumentData();
    return {
      title,
      participant: details["recipients.name"] || details["senders.name"] || details["emitters.name"] || "Participante não informado",
      amount: details["operation.amount"] || "0,00"
    };
  }

  function renderDocumentLibrary() {
    const list = document.getElementById("document-list");
    const search = document.getElementById("document-search").value.trim().toLocaleLowerCase("pt-BR");
    if (!apiBaseUrl || !sessionToken) {
      list.textContent = "Entre para consultar os documentos compartilhados.";
      return Promise.resolve();
    }
    return getAllDocuments().then((documents) => {
      documents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const visible = documents.filter((item) => `${item.type} ${item.number} ${item.title} ${item.participant}`.toLocaleLowerCase("pt-BR").includes(search));
      list.replaceChildren();
      document.getElementById("library-summary").textContent = `${documents.length} documento(s) no espaço compartilhado`;
      if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "library-empty";
        empty.textContent = documents.length ? "Nenhum documento corresponde à busca." : "Ainda não há documentos salvos. Monte um documento e salve-o como rascunho numerado.";
        list.append(empty);
        return;
      }
      visible.slice(0, 8).forEach((item) => {
        const row = document.createElement("article");
        row.className = "document-record";
        const type = document.createElement("span");
        type.className = "record-type";
        type.textContent = item.type.toUpperCase();
        const details = document.createElement("div");
        details.className = "record-details";
        const title = document.createElement("strong");
        title.textContent = `${item.title} · ${String(item.number).padStart(6, "0")}`;
        const subtitle = document.createElement("span");
        subtitle.textContent = `${item.participant} · atualizado ${new Date(item.updatedAt).toLocaleString("pt-BR")}`;
        details.append(title, subtitle);
        const status = document.createElement("span");
        status.className = "record-status";
        status.textContent = item.validation || "Rascunho de teste";
        const actions = document.createElement("div");
        actions.className = "record-actions";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "tool-button";
        open.textContent = "Abrir";
        open.addEventListener("click", () => openDocument(item));
        const download = document.createElement("button");
        download.type = "button";
        download.className = "tool-button";
        download.textContent = "XML";
        download.addEventListener("click", () => downloadSavedDocument(item));
        actions.append(open, download);
        row.append(type, details, status, actions);
        list.append(row);
      });
      if (visible.length > 8) {
        const more = document.createElement("p");
        more.className = "library-empty";
        more.textContent = `Mostrando 8 de ${visible.length} registros. Refine a busca para localizar outros.`;
        list.append(more);
      }
    }).catch((error) => {
      document.getElementById("library-summary").textContent = "Não foi possível ler os documentos salvos.";
      feedback(`Falha ao carregar documentos: ${error.message}`, "error");
    });
  }

  function downloadSavedDocument(record) {
    if (!record.xml) {
      feedback("Este registro não contém um XML salvo.", "error");
      return;
    }
    const blob = new Blob([record.xml], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${record.type}-teste-${String(record.number).padStart(6, "0")}.xml`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveCurrentDocument(automatic = false) {
    if (!apiBaseUrl || !sessionToken) return feedback("Entre no banco compartilhado antes de salvar documentos.", "error");
    if (isSavingDocument) return;
    if (currentType() === "nfe" && !productsAreValid()) {
      if (!automatic) validateProducts();
      return;
    }
    isSavingDocument = true;
    const state = window.oficinaState;
    const type = currentType();
    const documentId = activeDocumentId || crypto.randomUUID();
    const execute = async () => {
      if (assignedNumber === null) {
        const allocation = await apiRequest(`/counters/${encodeURIComponent(type)}/next`, { method: "POST", body: "{}" });
        assignedNumber = allocation.number;
        activeDocumentId = documentId;
        activeDocumentCreatedAt = new Date().toISOString();
      }
      const snapshot = captureDocumentData();
      state.number = assignedNumber;
      window.oficinaRender();
      const xml = repairAndPopulate();
      const details = documentDescription();
      const now = new Date().toISOString();
      const products = type === "nfe" ? snapshot.products.filter((product) =>
        !(product.description.toLocaleUpperCase("pt-BR") === "PRODUTO FICTICIO PARA TESTE" && product.ncm === "00000000")
      ).map((product) => ({ id: productCatalogId(product), description: product.description, ncm: product.ncm, unitPrice: parseAmount(product.unitPrice), updatedAt: now })) : [];
      const saved = {
        id: documentId,
        type,
        number: assignedNumber,
        title: details.title,
        participant: details.participant,
        amount: details.amount,
        status: "Rascunho de teste",
        validation: "Não validado",
        data: snapshot,
        references: [...catalog.selected],
        xml,
        createdAt: activeDocumentCreatedAt || now,
        updatedAt: now
      };
      const record = await apiRequest("/documents/save", { method: "POST", body: JSON.stringify({ document: saved, products }) });
      return { record, snapshot };
    };
    execute().then(({ record: saved, snapshot }) => {
      isSavingDocument = false;
      isDirty = JSON.stringify(captureDocumentData()) !== JSON.stringify(snapshot);
      activeDocumentId = saved.id;
      activeDocumentCreatedAt = saved.createdAt;
      assignedNumber = saved.number;
      document.getElementById("generate-button").textContent = "Salvar alterações";
      window.oficinaState.number = saved.number;
      window.oficinaRender();
      document.getElementById("document-id").textContent = `${type.toUpperCase()}-${String(saved.number).padStart(8, "0")}`;
      const status = document.getElementById("database-status");
      status.textContent = automatic ? `Sincronizado · ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Banco D1 · salvo";
      status.dataset.state = "ready";
      if (!automatic) feedback(`${type.toUpperCase()} de teste ${String(saved.number).padStart(6, "0")} salvo no banco compartilhado.`);
      renderDocumentLibrary();
      renderProductCatalog();
      if (isDirty) scheduleAutoSave();
    }).catch((error) => {
      isSavingDocument = false;
      document.getElementById("database-status").textContent = "Falha no banco compartilhado";
      document.getElementById("database-status").dataset.state = "error";
      feedback(`Não foi possível salvar no banco compartilhado: ${error.message}`, "error");
    });
  }

  function openDocument(record) {
    if (isSavingDocument) {
      feedback("Aguarde a conclusão do salvamento automático antes de abrir outro documento.", "pending");
      return;
    }
    if (isDirty && !window.confirm("Há alterações ainda não salvas. Descartar essas alterações e abrir outro documento?")) return;
    clearTimeout(autoSaveTimer);
    isDirty = false;
    loadingDocument = true;
    document.querySelector(`.tab[data-type="${record.type}"]`).click();
    loadingDocument = false;
    activeDocumentId = record.id;
    activeDocumentCreatedAt = record.createdAt;
    assignedNumber = record.number;
    catalog.selected = [...(record.references || [])];
    renderReferences();
    window.oficinaState.number = record.number;
    window.oficinaRender();
    if (record.type === "nfe" && !Array.isArray(record.data?.products)) {
      renderProducts([{ description: "PRODUTO FICTICIO PARA TESTE", ncm: "00000000", quantity: "1", unitPrice: "100.00" }]);
    }
    Object.entries(record.data || {}).forEach(([key, value]) => {
      if (key === "products" && Array.isArray(value)) {
        renderProducts(value);
        return;
      }
      const separator = key.indexOf(".");
      const groupName = key.slice(0, separator);
      const name = key.slice(separator + 1);
      const field = groupName === "operation"
        ? panel.querySelector(`.doc-fields [name="${name}"]`)
        : panel.querySelector(`[data-group="${groupName}"] [name="${name}"]`);
      if (field) field.value = value;
    });
    updateDocumentFields();
    document.getElementById("generate-button").textContent = "Salvar alterações";
    document.getElementById("document-id").textContent = `${record.type.toUpperCase()}-${String(record.number).padStart(8, "0")}`;
    refreshDocument();
    setWorkflowStep(1);
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function startNewDocument() {
    if (isSavingDocument) {
      feedback("Aguarde a conclusão do salvamento automático antes de iniciar outro documento.", "pending");
      return;
    }
    if (isDirty && !window.confirm("Há alterações ainda não salvas. Descartá-las e iniciar outro documento?")) return;
    clearTimeout(autoSaveTimer);
    isDirty = false;
    activeDocumentId = null;
    activeDocumentCreatedAt = null;
    assignedNumber = null;
    document.getElementById("generate-button").textContent = "Salvar rascunho numerado";
    const counter = await getRecord("counters", currentType());
    window.oficinaState.number = (counter?.number || 0) + 1;
    window.oficinaRender();
    refreshDocument();
    setWorkflowStep(1);
  }

  function groupFields(group) {
    return Object.fromEntries([...group.querySelectorAll("input[name]")].map((input) => [input.name, input.value.trim()]));
  }

  function writeGroup(group, record) {
    Object.entries(record).forEach(([key, value]) => {
      const input = group.querySelector(`[name="${key}"]`);
      if (input) input.value = value || "";
    });
    refreshDocument();
  }

  function refreshProfileSelects() {
    panel.querySelectorAll("select[data-list]").forEach((select) => {
      const items = catalog[select.dataset.list] || [];
      const current = select.value;
      const search = panel.querySelector(`[data-profile-search="${select.dataset.list}"]`)?.value.trim().toLocaleLowerCase("pt-BR") || "";
      const filtered = items.filter((item) => `${item.name || ""} ${item.cnpj || ""} ${item.plate || ""}`.toLocaleLowerCase("pt-BR").includes(search));
      const selected = items.find((item) => item.id === current);
      if (selected && !filtered.includes(selected)) filtered.unshift(selected);
      select.replaceChildren(new Option("Sem cadastro salvo", ""));
      filtered.forEach((item) => select.add(new Option(`${item.name || item.plate || item.cnpj} · ${item.cnpj || item.plate || ""}`, item.id)));
      if (items.some((item) => item.id === current)) select.value = current;
    });
  }

  async function saveProfile(group, automatic = false) {
    const listName = group.dataset.group;
    const profile = groupFields(group);
    if (!Object.values(profile).some(Boolean)) return false;
    const isVehicle = listName === "vehicles";
    const idField = isVehicle ? "plate" : "cnpj";
    const normalizedId = isVehicle
      ? (profile[idField] || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
      : (profile[idField] || "").replace(/\D/g, "");
    if (!normalizedId) {
      if (!automatic) feedback("Informe CNPJ ou placa para identificar o cadastro.", "error");
      return false;
    }
    const profileName = isVehicle ? profile.driver : profile.name;
    if (automatic && (
      (isVehicle ? !/^[A-Z0-9]{7}$/.test(normalizedId) || normalizedId === "XXX0X00" : !/^\d{14}$/.test(normalizedId) || /^0+$/.test(normalizedId)) ||
      !profileName || /FICTICIO|TESTE/i.test(profileName)
    )) {
      return false;
    }
    const records = catalog[listName];
    const existing = records.find((entry) => entry.key === normalizedId);
    const id = `${listName}-${normalizedId}`;
    const saved = { ...profile, id, key: normalizedId, type: listName };
    if (existing) Object.assign(existing, saved);
    else records.push(saved);
    try {
      await apiRequest(`/profiles/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(saved) });
      refreshProfileSelects();
      const select = group.querySelector("select");
      if (select) select.value = saved.id;
      if (automatic) {
        const status = group.querySelector(".profile-save-status");
        status.textContent = "Cadastro salvo no banco compartilhado";
        setTimeout(() => { status.textContent = ""; }, 2200);
      } else feedback(`${group.querySelector("h3").textContent} salvo no banco compartilhado.`);
      return true;
    } catch (error) {
      feedback(`Não foi possível salvar o cadastro no banco compartilhado: ${error.message}`, "error");
      return false;
    }
  }

  function scheduleProfileAutoSave(group) {
    if (!group) return;
    clearTimeout(profileSaveTimers.get(group));
    profileSaveTimers.set(group, setTimeout(() => saveProfile(group, true), 900));
  }

  function directChild(parent, name) {
    return [...(parent?.children || [])].find((child) => localName(child) === name) || null;
  }

  function descendant(parent, name) {
    return [...(parent?.getElementsByTagName("*") || [])].find((child) => localName(child) === name) || null;
  }

  function setChildText(parent, name, value) {
    const target = directChild(parent, name);
    if (target && value !== undefined && value !== "") target.textContent = value;
  }

  function fiscalCityName(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  }

  function parseAmount(value, fallback = 0) {
    const normalized = String(value || "").trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return fallback;
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : fallback;
  }

  function parseQuantity(value, fallback = 0) {
    const normalized = String(value || "").trim().replace(",", ".");
    if (!/^\d+(?:\.\d{1,4})?$/.test(normalized)) return fallback;
    const quantity = Number(normalized);
    return Number.isFinite(quantity) ? quantity : fallback;
  }

  function appendXmlElement(xmlDoc, parent, name, value = "") {
    const element = xmlDoc.createElementNS(parent.namespaceURI, name);
    if (value !== "") element.textContent = value;
    parent.append(element);
    return element;
  }

  function setParty(xmlDoc, root, tagName, groupName) {
    const group = panel.querySelector(`[data-group="${groupName}"]`);
    const party = descendant(root, tagName);
    if (!group || !party) return;
    const values = groupFields(group);
    setChildText(party, "CNPJ", values.cnpj.replace(/\D/g, ""));
    setChildText(party, "xNome", values.name);
    if (["cte", "mdfe"].includes(currentType())) {
      const ie = descendant(party, "IE");
      if (ie && ie.textContent === "ISENTO") ie.textContent = "000000000";
    }
  }

  function currentType() {
    return document.querySelector(".tab[aria-pressed='true']")?.dataset.type || "nfe";
  }

  function selectedReferences() {
    const selected = new Set(catalog.selected);
    return catalog.references.filter((reference) => selected.has(reference.id) && allowedReferenceTypes(currentType()).includes(reference.type));
  }

  function allowedReferenceTypes(type) {
    return type === "cte" ? ["nfe", "cte"] : type === "mdfe" ? ["nfe", "cte"] : [];
  }

  function updateDocumentFields() {
    const type = currentType();
    panel.querySelector(".profile-grid").dataset.documentType = type;
    panel.querySelectorAll("[data-document-types]").forEach((field) => {
      const types = field.dataset.documentTypes.split(",");
      field.hidden = !types.includes("all") && !types.includes(type);
    });
    const amountLabel = panel.querySelector('label[data-label-nfe]');
    if (amountLabel) amountLabel.firstChild.textContent = amountLabel.dataset[`label${type[0].toUpperCase()}${type.slice(1)}`] || "Valor da operação";
    const heading = document.getElementById("emission-heading");
    const description = document.getElementById("emission-description");
    const hint = document.getElementById("reference-hint");
    const copy = {
      nfe: ["Dados da NF-e", "Informe a operação, o CFOP e os valores da venda.", "NF-e e NFS-e não recebem documentos vinculados neste fluxo."],
      cte: ["Dados do CT-e", "Informe o frete, a origem, o destino e as notas ou CT-es anteriores.", "O CT-e aceita NF-e e CT-e anteriores; MDF-e não pode ser vinculado."],
      mdfe: ["Dados do MDF-e", "Informe o percurso e os documentos fiscais que serão transportados.", "O MDF-e aceita NF-e e CT-e; MDF-e não pode ser vinculado."],
      nfse: ["Dados da NFS-e", "Informe município, competência, serviço e valor.", "A NFS-e não aceita documentos de transporte vinculados."]
    }[type];
    heading.textContent = copy[0];
    description.textContent = copy[1];
    hint.textContent = copy[2];
    const competence = panel.querySelector('input[name="competence"]');
    if (competence && !competence.value) competence.value = new Date().toISOString().slice(0, 10);
    renderReferences();
  }

  function setOperationDefaults(type) {
    const values = {
      cfop: type === "nfe" ? "5102" : "6353",
      nature: type === "nfe" ? "VENDA DE MERCADORIA - TESTE" : "PRESTACAO DE SERVICO DE TRANSPORTE - TESTE",
      cargoDescription: "VOLUME FICTICIO",
      amount: type === "nfe" ? "100.00" : "250.00",
      serviceDescription: "SERVICO FICTICIO PARA TESTE - SEM PRESTACAO REAL"
    };
    Object.entries(values).forEach(([name, value]) => {
      const input = panel.querySelector(`.doc-fields [name="${name}"]`);
      if (input) input.value = value;
    });
    const competence = panel.querySelector('input[name="competence"]');
    if (competence) competence.value = new Date().toISOString().slice(0, 10);
    if (type === "nfe") renderProducts([{ description: "PRODUTO FICTICIO PARA TESTE", ncm: "00000000", quantity: "1", unitPrice: "100.00" }]);
  }

  function textElement(xmlDoc, parent, name, value) {
    const node = appendXmlElement(xmlDoc, parent, name, value);
    return node;
  }

  function applyReferences(xmlDoc, root, type) {
    const references = selectedReferences();
    if (type === "cte") {
      const info = descendant(root, "infCTeNorm");
      const infoDocs = descendant(info, "infDoc");
      const nfeReferences = references.filter((item) => item.type === "nfe");
      if (infoDocs) {
        infoDocs.replaceChildren();
        nfeReferences.forEach((item) => {
          const nfe = appendXmlElement(xmlDoc, infoDocs, "infNFe");
          textElement(xmlDoc, nfe, "chave", item.key);
        });
      }
      const priorCte = references.filter((item) => item.type === "cte");
      const previousDocuments = directChild(info, "docAnt");
      if (previousDocuments) info.removeChild(previousDocuments);
      if (priorCte.length) {
        const modal = directChild(info, "infModal");
        const previous = appendXmlElement(xmlDoc, info, "docAnt");
        if (modal) info.insertBefore(previous, modal);
        priorCte.forEach((item) => {
          const issuer = appendXmlElement(xmlDoc, previous, "emiDocAnt");
          textElement(xmlDoc, issuer, "CNPJ", /^\d{14}$/.test(item.issuerCnpj || "") ? item.issuerCnpj : "00000000000000");
          textElement(xmlDoc, issuer, "IE", item.issuerIe || "000000000");
          textElement(xmlDoc, issuer, "UF", item.issuerUf || "SP");
          textElement(xmlDoc, issuer, "xNome", item.issuerName || "EMITENTE ANTERIOR FICTICIO");
          const id = appendXmlElement(xmlDoc, issuer, "idDocAnt");
          const electronic = appendXmlElement(xmlDoc, id, "idDocAntEle");
          textElement(xmlDoc, electronic, "chCTe", item.key);
        });
      }
    }
    if (type === "mdfe") {
      const infoDocs = descendant(root, "infDoc");
      if (infoDocs) {
        infoDocs.replaceChildren();
        const unload = appendXmlElement(xmlDoc, infoDocs, "infMunDescarga");
        const fields = Object.fromEntries([...panel.querySelectorAll(".doc-fields input, .doc-fields select")].map((input) => [input.name, input.value.trim()]));
        textElement(xmlDoc, unload, "cMunDescarga", fields.destinationCode || "3304557");
        textElement(xmlDoc, unload, "xMunDescarga", fiscalCityName(fields.destinationName || "RIO DE JANEIRO"));
        ["cte", "nfe"].forEach((type) => references.filter((item) => item.type === type).forEach((item) => {
          const documentNode = appendXmlElement(xmlDoc, unload, type === "cte" ? "infCTe" : "infNFe");
          textElement(xmlDoc, documentNode, type === "cte" ? "chCTe" : "chNFe", item.key);
        }));
      }
    }
  }

  function buildNationalDps() {
    const readFields = Object.fromEntries([...panel.querySelectorAll(".doc-fields input, .doc-fields select")].map((input) => [input.name, input.value.trim()]));
    const emitter = groupFields(panel.querySelector('[data-group="emitters"]'));
    const recipient = groupFields(panel.querySelector('[data-group="recipients"]'));
    const cnpj = (emitter.cnpj || "00000000000000").replace(/\D/g, "").padStart(14, "0").slice(-14);
    const recipientCnpj = (recipient.cnpj || "11111111111111").replace(/\D/g, "").padStart(14, "0").slice(-14);
    const municipality = /^\d{7}$/.test(readFields.originCode || "") ? readFields.originCode : "3550308";
    const number = document.getElementById("sample-number").textContent.replace(/\D/g, "") || "0001";
    const series = "00001";
    const dpsId = `DPS${municipality}2${cnpj}${series}${number.padStart(15, "0")}`;
    const date = new Date().toISOString();
    const serviceAmount = parseAmount(readFields.amount, 150).toFixed(2);
    const competence = /^\d{4}-\d{2}-\d{2}$/.test(readFields.competence || "") ? readFields.competence : date.slice(0, 10);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infDPS Id="${dpsId}">
    <tpAmb>2</tpAmb><dhEmi>${date}</dhEmi><verAplic>OficinaXML-1.0</verAplic><serie>${series}</serie><nDPS>${number}</nDPS><dCompet>${competence}</dCompet><tpEmit>1</tpEmit><cLocEmi>${municipality}</cLocEmi>
    <prest><CNPJ>${cnpj}</CNPJ><xNome>${escapeHtml(emitter.name || "PRESTADOR FICTICIO TESTE")}</xNome><regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>
    <toma><CNPJ>${recipientCnpj}</CNPJ><xNome>${escapeHtml(recipient.name || "TOMADOR FICTICIO TESTE")}</xNome></toma>
    <serv><locPrest><cLocPrestacao>${municipality}</cLocPrestacao></locPrest><cServ><cTribNac>010101</cTribNac><xDescServ>${escapeHtml(readFields.serviceDescription || "SERVICO FICTICIO PARA TESTE - SEM PRESTACAO REAL")}</xDescServ></cServ></serv>
    <valores><vServPrest><vServ>${serviceAmount}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>
  </infDPS>
</DPS>`;
    document.getElementById("xml-output").textContent = xml;
    return xml;
  }

  function repairAndPopulate() {
    const output = document.getElementById("xml-output");
    if (!output?.textContent) return null;
    if (currentType() === "nfse") return buildNationalDps();
    const original = output.textContent;
    const xmlDoc = new DOMParser().parseFromString(original, "application/xml");
    if (xmlDoc.querySelector("parsererror")) return null;
    const root = xmlDoc.documentElement;
    const type = currentType();
    const groups = { emit: "emitters", rem: "senders", dest: "recipients" };
    Object.entries(groups).forEach(([tagName, groupName]) => setParty(xmlDoc, root, tagName, groupName));

    const fields = Object.fromEntries([...panel.querySelectorAll(".doc-fields input, .doc-fields select")].map((input) => [input.name, input.value.trim()]));
    let amount = parseAmount(fields.amount, 250).toFixed(2);
    const products = type === "nfe" ? getProducts() : [];
    if (type === "nfe") {
      amount = products.reduce((sum, product) =>
        sum + parseQuantity(product.quantity) * parseAmount(product.unitPrice), 0).toFixed(2);
    }
    const ide = descendant(root, "ide");
    if (ide) {
      setChildText(ide, "CFOP", fields.cfop);
      setChildText(ide, "natOp", fields.nature);
      setChildText(ide, "cMunIni", fields.originCode);
      setChildText(ide, "xMunIni", fiscalCityName(fields.originName));
      setChildText(ide, "UFIni", fields.originUf.toUpperCase());
      setChildText(ide, "cMunFim", fields.destinationCode);
      setChildText(ide, "xMunFim", fiscalCityName(fields.destinationName));
      setChildText(ide, "UFFim", fields.destinationUf.toUpperCase());
      if (type === "cte" && !directChild(ide, "toma3") && !directChild(ide, "toma4")) {
        const toma = appendXmlElement(xmlDoc, ide, "toma3");
        textElement(xmlDoc, toma, "toma", "0");
      }
    }

    const operationTotals = type === "cte" ? ["vTPrest", "vRec", "vComp"] : type === "mdfe" ? ["vCarga"] : [];
    operationTotals.forEach((name) => {
      const target = descendant(root, name);
      if (target) target.textContent = amount;
    });
    if (type === "nfe") {
      const detailsParent = descendant(root, "infNFe");
      const detailNodes = [...(detailsParent?.children || [])].filter((node) => localName(node) === "det");
      const template = detailNodes[0];
      if (!template) return null;
      products.slice(detailNodes.length).forEach(() => detailsParent.insertBefore(template.cloneNode(true), directChild(detailsParent, "total")));
      const updatedDetails = [...detailsParent.children].filter((node) => localName(node) === "det");
      updatedDetails.slice(products.length).forEach((node) => node.remove());
      products.forEach((item, index) => {
        const detail = updatedDetails[index];
        const product = descendant(detail, "prod");
        const quantity = parseQuantity(item.quantity, 1);
        const unitPrice = parseAmount(item.unitPrice);
        const lineTotal = (quantity * unitPrice).toFixed(2);
        detail.setAttribute("nItem", String(index + 1));
        setChildText(product, "cProd", `TESTE-${String(index + 1).padStart(3, "0")}`);
        setChildText(product, "NCM", item.ncm);
        setChildText(product, "CFOP", fields.cfop);
        setChildText(product, "xProd", item.description);
        setChildText(product, "qCom", quantity.toFixed(4));
        setChildText(product, "vUnCom", unitPrice.toFixed(2));
        setChildText(product, "vProd", lineTotal);
        setChildText(product, "qTrib", quantity.toFixed(4));
        setChildText(product, "vUnTrib", unitPrice.toFixed(2));
      });
      const totals = descendant(root, "ICMSTot");
      setChildText(totals, "vProd", amount);
      setChildText(totals, "vNF", amount);
      const paymentTotal = descendant(root, "vPag");
      if (paymentTotal) paymentTotal.textContent = amount;
    }
    if (type === "cte") setChildText(descendant(root, "infCarga"), "proPred", fields.cargoDescription || "CARGA FICTICIA PARA TESTE");
    const vehicleGroup = panel.querySelector('[data-group="vehicles"]');
    if (vehicleGroup) {
      const vehicle = descendant(root, "veicTracao");
      if (vehicle) {
        setChildText(vehicle, "placa", groupFields(vehicleGroup).plate.toUpperCase());
        setChildText(vehicle, "RNTRC", groupFields(vehicleGroup).rntrc);
        setChildText(descendant(vehicle, "condutor"), "xNome", groupFields(vehicleGroup).driver);
      }
    }

    if (type === "cte" || type === "mdfe") {
      root.querySelectorAll("IE").forEach((node) => {
        if (node.textContent === "ISENTO") node.textContent = "000000000";
      });
      applyReferences(xmlDoc, root, type);
      if (type === "cte") {
        const infCte = descendant(root, "infCte");
        const invalidAditionalInfo = directChild(infCte, "infAdic");
        if (invalidAditionalInfo) infCte.removeChild(invalidAditionalInfo);
        const supplement = directChild(infCte, "infCteSupl");
        if (supplement) {
          infCte.removeChild(supplement);
          root.append(supplement);
        }
      }
      if (type === "mdfe") {
        const total = descendant(root, "tot");
        if (total && !directChild(total, "cUnid")) {
          textElement(xmlDoc, total, "cUnid", "01");
          textElement(xmlDoc, total, "qCarga", "1.0000");
        }
      }
    }

    const serialized = new XMLSerializer().serializeToString(xmlDoc);
    const xml = serialized.startsWith("<?xml") ? serialized : `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
    output.textContent = xml;
    return xml;
  }

  function currentFilename() {
    return document.getElementById("file-name")?.textContent || `amostra-${currentType()}.xml`;
  }

  function downloadXml() {
    if (currentType() === "nfe" && !validateProducts()) return;
    const xml = repairAndPopulate();
    if (!xml) return feedback("Não foi possível montar um XML bem formado.", "error");
    const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = currentFilename();
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback("XML de teste baixado sem assinatura digital. Não possui validade fiscal e não pode ser transmitido.", "pending");
  }

  function persistValidation(label) {
    if (!activeDocumentId || !sessionToken) return;
    const xml = repairAndPopulate();
    const details = documentDescription();
    apiRequest(`/documents/${encodeURIComponent(activeDocumentId)}`, { method: "PATCH", body: JSON.stringify({
      validation: label,
      xml,
      data: captureDocumentData(),
      references: [...catalog.selected],
      title: details.title,
      participant: details.participant,
      amount: details.amount,
      updatedAt: new Date().toISOString()
    }) }).then(renderDocumentLibrary).catch((error) => feedback(`Não foi possível salvar o resultado da validação no banco compartilhado: ${error.message}`, "error"));
  }

  async function validateXml() {
    if (currentType() === "nfe" && !validateProducts()) return;
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
      feedback("O GitHub Pages não executa o validador XSD local. Para validar, abra a aplicação pelo servidor local; nenhum dado foi transmitido.", "pending");
      return;
    }
    const xml = repairAndPopulate();
    if (!xml) return feedback("XML inválido: confira os dados e gere novamente.", "error");
    feedback("Validando no schema local…", "pending");
    try {
      const response = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentType: currentType(), xml })
      });
      const responseText = await response.text();
      if (!responseText.trim()) {
        throw new Error(`O validador respondeu sem conteúdo (HTTP ${response.status}). Inicie validate-server.ps1 e abra o sistema pelo endereço http://127.0.0.1:8765/.`);
      }
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(`O validador respondeu conteúdo que não é JSON (HTTP ${response.status}). Inicie validate-server.ps1 e abra o sistema pelo endereço http://127.0.0.1:8765/.`);
      }
      if (!response.ok) throw new Error(result.error || "Falha no validador local.");
      const details = (result.errors || []).map((error) => `Linha ${error.line || 0}, coluna ${error.column || 0}: ${error.message}`);
      const summary = result.cStat
        ? `FALHA XSD LOCAL · ${result.xMotivo}`
        : `${result.xMotivo} · ${result.source}`;
      feedback(`${summary} · ${result.version}`, result.isValid ? "ok" : "error", details);
      document.getElementById("validation-status").textContent = result.isValid ? "XSD aprovado localmente" : "XSD com falhas";
      persistValidation(result.isValid ? "XSD válido · sem autorização fiscal" : "XSD com falhas · sem autorização fiscal");
    } catch (error) {
      feedback(`Validador local indisponível: ${error.message}. Nenhuma transmissão foi realizada.`, "error");
    }
  }

  function printContent() {
    const type = currentType();
    const xml = repairAndPopulate() || "XML não gerado";
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    const root = parsed.documentElement;
    const value = (source, name) => escapeHtml(descendant(source, name)?.textContent || "-");
    const inf = descendant(root, type === "nfe" ? "infNFe" : type === "cte" ? "infCte" : type === "mdfe" ? "infMDFe" : "infDPS");
    const id = inf?.getAttribute("Id") || "";
    const key = (id.match(/\d{44}/) || [type === "nfse" ? id : ""])[0];
    const issuer = descendant(root, "emit") || descendant(root, "prest");
    const customer = descendant(root, type === "cte" || type === "nfe" ? "dest" : type === "nfse" ? "toma" : "Tomador");
    const documentNumber = type === "nfe" ? value(root, "nNF") : type === "cte" ? value(root, "nCT") : type === "mdfe" ? value(root, "nMDF") : value(root, "nDPS");
    const issuedAt = value(root, "dhEmi");
    const currency = (amount) => amount === "-" ? "-" : `R$ ${escapeHtml(amount)}`;
    const cell = (label, text) => `<div class="document-cell"><span>${label}</span><strong>${text}</strong></div>`;
    const section = (title, content) => `<section class="document-section"><h3>${title}</h3>${content}</section>`;
    const table = (headers, rows) => `<table class="document-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
    const party = (partyNode) => `<strong>${value(partyNode, "xNome")}</strong><span>CNPJ ${value(partyNode, "CNPJ")}</span>`;
    const refs = selectedReferences().map((item) => `<tr><td>${escapeHtml(item.type.toUpperCase())}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.key)}</td></tr>`).join("") || `<tr><td colspan="3">Nenhum documento associado</td></tr>`;
    const header = (kind, subtitle) => `<div class="document-warning">DOCUMENTO FICTÍCIO · SEM VALIDADE FISCAL · NÃO ENVIAR À SEFAZ</div><header class="document-head"><div class="document-brand"><span class="document-symbol">OT</span><span>OFICINA DE TESTES<small>Documento auxiliar simulado</small></span></div><div class="document-kind"><strong>${kind}</strong><span>${subtitle}</span></div><div class="document-number"><span>NÚMERO</span><strong>${documentNumber}</strong><span>SÉRIE ${value(root, "serie")}</span></div></header><div class="document-key"><span>CHAVE DE ACESSO · FICTÍCIA</span><strong>${key || "Chave não encontrada"}</strong><small>Não autoriza circulação, transporte ou prestação de serviço.</small></div>`;

    let content = "";
    if (type === "nfe") {
      const products = [...root.getElementsByTagName("*")].filter((node) => localName(node) === "det").map((item) => {
        const product = descendant(item, "prod");
        return `<tr><td>${value(product, "cProd")}</td><td>${value(product, "xProd")}</td><td>${value(product, "NCM")}</td><td>${value(product, "CFOP")}</td><td>${value(product, "qCom")}</td><td>${currency(value(product, "vUnCom"))}</td><td>${currency(value(product, "vProd"))}</td></tr>`;
      }).join("") || `<tr><td colspan="7">Sem itens informados</td></tr>`;
      content = `${header("DANFE", "Representação auxiliar de NF-e · modelo 55")}<div class="document-grid two">${cell("NATUREZA DA OPERAÇÃO", value(root, "natOp"))}${cell("DATA DE EMISSÃO", issuedAt)}${cell("EMITENTE", party(issuer))}${cell("DESTINATÁRIO", party(customer))}</div>${section("Produtos / serviços", table(["CÓDIGO", "DESCRIÇÃO", "NCM", "CFOP", "QTDE", "UNITÁRIO", "TOTAL"], products))}<div class="document-grid totals">${cell("VALOR DOS PRODUTOS", currency(value(descendant(root, "ICMSTot"), "vProd")))}${cell("VALOR TOTAL DA NOTA", currency(value(root, "vNF")))}</div><footer class="document-foot">DANFE de teste. O documento oficial depende de autorização e XML válido.</footer>`;
    } else if (type === "cte") {
      const ide = descendant(root, "ide");
      const from = `${value(ide, "xMunIni")} / ${value(ide, "UFIni")}`;
      const to = `${value(ide, "xMunFim")} / ${value(ide, "UFFim")}`;
      const charge = [...root.getElementsByTagName("*")].filter((node) => localName(node) === "infNFe").map((item) => `<tr><td>NF-e</td><td>${value(item, "chave")}</td></tr>`).join("") || refs;
      content = `${header("DACTE", "Representação auxiliar de CT-e · modelo 57")}<div class="document-route"><div><span>INÍCIO DA PRESTAÇÃO</span><strong>${from}</strong></div><span class="route-arrow">→</span><div><span>FIM DA PRESTAÇÃO</span><strong>${to}</strong></div></div><div class="document-grid two">${cell("EMITENTE", party(issuer))}${cell("TOMADOR / DESTINATÁRIO", party(customer))}${cell("REMETENTE", party(descendant(root, "rem")))}${cell("DATA DE EMISSÃO", issuedAt)}</div><div class="document-grid totals">${cell("VALOR DO FRETE", currency(value(root, "vTPrest")))}${cell("VALOR DA CARGA", currency(value(root, "vCarga")))}</div>${section("Documentos transportados", table(["TIPO", "CHAVE DE ACESSO"], charge))}<footer class="document-foot">DACTE simulado. Não acoberta prestação de transporte.</footer>`;
    } else if (type === "mdfe") {
      const ide = descendant(root, "ide");
      const vehicle = descendant(root, "veicTracao");
      const docs = selectedReferences().map((item) => `<tr><td>${escapeHtml(item.type.toUpperCase())}</td><td>${escapeHtml(item.key)}</td></tr>`).join("") || `<tr><td colspan="2">Nenhum documento vinculado</td></tr>`;
      content = `${header("DAMDFE", "Representação auxiliar de MDF-e · modelo 58")}<div class="document-route"><div><span>UF DE CARREGAMENTO</span><strong>${value(ide, "UFIni")}</strong></div><span class="route-arrow">→</span><div><span>UF DE DESCARREGAMENTO</span><strong>${value(ide, "UFFim")}</strong></div></div><div class="document-grid two">${cell("EMITENTE", party(issuer))}${cell("EMISSÃO", issuedAt)}${cell("VEÍCULO DE TRAÇÃO", value(vehicle, "placa"))}${cell("RNTRC", value(vehicle, "RNTRC"))}${cell("MOTORISTA", value(vehicle, "xNome"))}${cell("CARGA", value(root, "xProd"))}</div>${section("Documentos fiscais vinculados", table(["TIPO", "CHAVE DE ACESSO"], docs))}<footer class="document-foot">DAMDFE simulado. Não autoriza trânsito de carga.</footer>`;
    } else {
      content = `${header("DANFSe", "Visualização de DPS · NFS-e Nacional 1.01")}<div class="document-grid two">${cell("PRESTADOR", party(issuer))}${cell("TOMADOR", party(customer))}${cell("NÚMERO DA DPS", documentNumber)}${cell("DATA DE EMISSÃO", issuedAt)}${cell("COMPETÊNCIA", value(root, "dCompet"))}${cell("MUNICÍPIO DE PRESTAÇÃO", value(root, "cLocPrestacao"))}</div>${section("Descrição do serviço", `<p class="service-description">${value(root, "xDescServ")}</p>`)}<div class="document-grid totals">${cell("VALOR DO SERVIÇO", currency(value(root, "vServ")))}${cell("RETENÇÃO DO ISS", value(root, "tpRetISSQN") === "1" ? "Não retido" : value(root, "tpRetISSQN"))}</div><footer class="document-foot">Prévia de teste da DPS nacional. A NFS-e somente existe após processamento pelo sistema autorizado.</footer>`;
    }
    document.getElementById("print-sheet").innerHTML = `<article class="auxiliary-document doc-${type}">${content}<div class="document-watermark" aria-hidden="true">TESTE</div></article>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function renderReferences() {
    const list = document.getElementById("reference-list");
    list.replaceChildren();
    const allowedTypes = allowedReferenceTypes(currentType());
    let incompatibleCount = 0;
    catalog.references.forEach((reference) => {
      const label = document.createElement("label");
      label.className = "reference-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const compatible = allowedTypes.includes(reference.type);
      checkbox.checked = compatible && catalog.selected.includes(reference.id);
      checkbox.disabled = !compatible;
      if (!compatible && catalog.selected.includes(reference.id)) incompatibleCount += 1;
      checkbox.addEventListener("change", () => {
        catalog.selected = checkbox.checked ? [...new Set([...catalog.selected, reference.id])] : catalog.selected.filter((id) => id !== reference.id);
        isDirty = true;
        refreshDocument();
        scheduleAutoSave();
      });
      const name = document.createElement("span");
      name.textContent = `${reference.type.toUpperCase()} · ${reference.name}`;
      const key = document.createElement("code");
      key.textContent = compatible ? reference.key : `${reference.key} · incompatível`;
      label.append(checkbox, name, key);
      list.append(label);
    });
    if (!catalog.references.length) list.textContent = "Nenhum XML importado ainda.";
    if (incompatibleCount) {
      const warning = document.createElement("p");
      warning.className = "reference-warning";
      warning.textContent = `${incompatibleCount} arquivo(s) incompatível(is) desmarcado(s); eles não serão incluídos no XML.`;
      list.prepend(warning);
    }
  }

  async function readReferenceFiles(files) {
    const results = [];
    const priorReferences = [...catalog.references];
    const priorSelected = [...catalog.selected];
    for (const file of files) {
      try {
        const source = await file.text();
        const parsed = new DOMParser().parseFromString(source, "application/xml");
        if (parsed.querySelector("parsererror")) throw new Error("XML malformado");
        const rootName = localName(parsed.documentElement);
        const keyNode = [...parsed.getElementsByTagName("*")].find((node) => ["chNFe", "chCTe", "chave", "chMDFe"].includes(localName(node)) && /\d{44}/.test(node.textContent));
        const id = parsed.documentElement.getAttribute("Id") || descendant(parsed, "infNFe")?.getAttribute("Id") || descendant(parsed, "infCte")?.getAttribute("Id") || descendant(parsed, "infMDFe")?.getAttribute("Id") || "";
        const key = (id.match(/\d{44}/) || keyNode?.textContent.match(/\d{44}/) || [])[0];
        const type = /NFe|nfeProc/i.test(rootName) || descendant(parsed, "infNFe") ? "nfe" : /CTe|cteProc/i.test(rootName) || descendant(parsed, "infCte") ? "cte" : /MDFe|mdfeProc/i.test(rootName) || descendant(parsed, "infMDFe") ? "mdfe" : null;
        if (!type || !key) throw new Error("Tipo ou chave de acesso de 44 dígitos não identificado");
        const issuer = descendant(descendant(parsed, "emit"), "CNPJ") || descendant(descendant(parsed, "prest"), "Cnpj");
        const issuerName = descendant(descendant(parsed, "emit"), "xNome") || descendant(descendant(parsed, "prest"), "xNome");
        const issuerIe = descendant(descendant(parsed, "emit"), "IE");
        const issuerUf = descendant(descendant(parsed, "emit"), "UF");
        results.push({
          id: crypto.randomUUID(),
          type,
          key,
          name: file.name,
          issuerCnpj: issuer?.textContent || "",
          issuerName: issuerName?.textContent || "",
          issuerIe: issuerIe?.textContent || "",
          issuerUf: issuerUf?.textContent || ""
        });
      } catch (error) {
        feedback(`${file.name}: ${error.message}.`, "error");
      }
    }
    const known = new Set(catalog.references.map((item) => item.key));
    const added = results.filter((item) => !known.has(item.key));
    added.forEach((item) => catalog.references.push(item));
    const allowed = allowedReferenceTypes(currentType());
    const compatible = added.filter((item) => allowed.includes(item.type));
    catalog.selected = [...new Set([...catalog.selected.filter((id) => {
      const reference = catalog.references.find((item) => item.id === id);
      return reference && allowed.includes(reference.type);
    }), ...compatible.map((item) => item.id)])];
    if (results.length) isDirty = true;
    try {
      await persistCatalog(added);
    } catch (error) {
      catalog.references = priorReferences;
      catalog.selected = priorSelected;
      renderReferences();
      feedback(`Não foi possível compartilhar os XMLs no banco: ${error.message}`, "error");
      return;
    }
    renderReferences();
    refreshDocument();
    if (results.length) {
      const rejected = added.filter((item) => !allowed.includes(item.type)).length;
      feedback(`${results.length} XML(s) lido(s); ${compatible.length} compatível(is) selecionado(s)${rejected ? ` e ${rejected} incompatível(is) deixado(s) de fora` : ""}.`);
    }
  }

  function refreshDocument() {
    const xml = repairAndPopulate();
    if (!xml) return;
    const badge = document.getElementById("layout-badge");
    badge.textContent = currentType() === "cte" ? "CT-e 4.00 · NT 2026.002 v1.01" : currentType() === "mdfe" ? "MDF-e 3.00b · NT 2025.001 v1.03" : currentType() === "nfse" ? "NFS-e Nacional · DPS 1.01" : "NF-e 4.00 · PL 010f / NT 2026.007";
    printContent();
  }

  function setWorkflowStep(step) {
    panel.querySelectorAll(".workflow-stage").forEach((stage) => { stage.hidden = stage.dataset.stage !== String(step); });
    panel.querySelectorAll(".workflow-step").forEach((button) => {
      const current = button.dataset.workflowStep === String(step);
      button.classList.toggle("current", current);
      button.setAttribute("aria-current", current ? "step" : "false");
    });
  }

  async function fetchIbge(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`IBGE respondeu HTTP ${response.status}`);
    return response.json();
  }

  async function loadIbgeOptions() {
    const status = document.getElementById("ibge-status");
    const stateSelects = [...panel.querySelectorAll('select[data-city-side][name$="Uf"]')];
    try {
      let states;
      const cached = JSON.parse(localStorage.getItem("oficina-xml.ibge.states.v1") || "null");
      if (cached?.savedAt && Date.now() - cached.savedAt < 30 * 24 * 60 * 60 * 1000) states = cached.items;
      else {
        states = await fetchIbge("https://servicodados.ibge.gov.br/api/v1/localidades/estados?orderBy=nome");
        localStorage.setItem("oficina-xml.ibge.states.v1", JSON.stringify({ savedAt: Date.now(), items: states }));
      }
      stateSelects.forEach((select) => {
        const selected = select.value;
        select.replaceChildren(...states.map((state) => new Option(`${state.nome} (${state.sigla})`, state.sigla)));
        if (states.some((state) => state.sigla === selected)) select.value = selected;
      });
      status.textContent = "Localidades oficiais · IBGE";
      status.dataset.state = "ready";
      await Promise.all([loadMunicipalities("origin"), loadMunicipalities("destination")]);
    } catch (error) {
      status.textContent = "IBGE indisponível · usando valores editáveis";
      status.dataset.state = "offline";
      feedback(`Não consegui consultar a API do IBGE (${error.message}). Os códigos e nomes atuais continuam editáveis.`, "pending");
      panel.querySelectorAll('select[data-city-side]').forEach((select) => {
        const fallback = select.dataset.citySide === "origin" ? "São Paulo" : "Rio de Janeiro";
        select.replaceChildren(new Option(fallback, select.value));
      });
    }
  }

  async function loadMunicipalities(side, userInitiated = false) {
    const ufSelect = panel.querySelector(`select[data-city-side="${side}"][name$="Uf"]`);
    const citySelect = panel.querySelector(`select[data-city-side="${side}"][name$="Code"]`);
    const nameInput = panel.querySelector(`input[name="${side === "origin" ? "originName" : "destinationName"}"]`);
    const uf = ufSelect?.value;
    if (!uf || !citySelect) return;
    const codeBefore = citySelect.value;
    const cacheKey = `oficina-xml.ibge.cities.${uf}.v1`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      const municipalities = cached?.savedAt && Date.now() - cached.savedAt < 30 * 24 * 60 * 60 * 1000
        ? cached.items
        : await fetchIbge(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(uf)}/municipios?orderBy=nome`);
      if (!cached?.savedAt || Date.now() - cached.savedAt >= 30 * 24 * 60 * 60 * 1000) localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), items: municipalities }));
      citySelect.replaceChildren(...municipalities.map((city) => new Option(city.nome, String(city.id))));
      if (municipalities.some((city) => String(city.id) === codeBefore)) citySelect.value = codeBefore;
      else citySelect.selectedIndex = 0;
      if (nameInput) nameInput.value = citySelect.selectedOptions[0]?.textContent.toLocaleUpperCase("pt-BR") || "";
      refreshDocument();
      if (userInitiated) {
        isDirty = true;
        scheduleAutoSave();
      }
    } catch {
      const fallbackName = side === "origin" ? "SAO PAULO" : "RIO DE JANEIRO";
      citySelect.replaceChildren(new Option(`${fallbackName} · API indisponível`, codeBefore));
      if (nameInput) nameInput.value = fallbackName;
      if (userInitiated) {
        isDirty = true;
        scheduleAutoSave();
      }
    }
  }

  function showPrintPreview() {
    printContent();
    document.getElementById("print-preview-body").innerHTML = `<article class="preview-page">${document.getElementById("print-sheet").innerHTML}</article>`;
    document.getElementById("preview-overlay").hidden = false;
    document.getElementById("close-print-preview").focus();
  }

  function closePrintPreview() {
    document.getElementById("preview-overlay").hidden = true;
    document.getElementById("print-preview").focus();
  }

  async function initializeCloudflare() {
    const config = window.oficinaCloudflareConfig;
    const help = document.getElementById("cloud-auth-help");
    if (!config?.apiBaseUrl || config.apiBaseUrl.includes("SUBSTITUA_")) {
      help.innerHTML = 'Preencha a URL da API em <code>cloudflare-config.js</code> e implante conforme <code>CLOUDFLARE_SETUP.md</code>.';
      document.getElementById("cloud-login-button").disabled = true;
      return;
    }
    apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, "");
    help.textContent = "A API está configurada. Entre com sua conta.";
    if (sessionToken) {
      try {
        await activateSession(await apiRequest("/auth/me"));
      } catch (error) {
        sessionToken = "";
        sessionStorage.removeItem("oficina-xml.session.v1");
        document.getElementById("cloud-auth-help").textContent = `A sessão expirou ou a API está indisponível: ${error.message}`;
        document.getElementById("cloud-auth-help").dataset.state = "error";
      }
    }
  }

  async function activateSession(user) {
    const appPanel = document.getElementById("cloud-app");
    document.getElementById("database-status").textContent = "Conectando ao banco D1…";
    document.getElementById("database-status").dataset.state = "pending";
    await refreshSharedData();
    const counter = await getRecord("counters", currentType());
    window.oficinaState.number = (counter?.number || 0) + 1;
    window.oficinaRender();
    updateDocumentFields();
    refreshDocument();
    await Promise.all([renderDocumentLibrary(), renderProductCatalog()]);
    document.getElementById("cloud-login-form").hidden = true;
    document.getElementById("cloud-session").hidden = false;
    document.getElementById("cloud-user-email").textContent = user.email;
    appPanel.hidden = false;
    document.getElementById("database-status").textContent = "Banco D1 · conectado";
    document.getElementById("database-status").dataset.state = "ready";
    subscribeToSharedChanges();
    loadIbgeOptions();
  }

  function bind() {
    document.head.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="enhancements.css">');
    const workspace = document.querySelector(".workspace");
    workspace.parentNode.insertBefore(panel, workspace);
    const controls = workspace.querySelector(".controls");
    panel.querySelector("#type-selector-slot").append(controls.querySelector(".tabs"));
    panel.querySelector("#final-actions-slot").append(controls.querySelector(".actions"));
    panel.querySelector("#xml-preview-slot").append(workspace.querySelector(".preview"));
    workspace.hidden = true;
    document.body.insertAdjacentHTML("beforeend", '<section class="print-sheet" id="print-sheet" aria-label="Documento auxiliar para impressão"></section>');
    document.body.insertAdjacentHTML("beforeend", '<div class="preview-overlay" id="preview-overlay" hidden><section class="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="print-preview-title"><header class="preview-dialog-head"><h2 id="print-preview-title">Prévia para impressão</h2><button class="tool-button" id="close-print-preview" type="button">Fechar</button></header><div class="preview-dialog-body" id="print-preview-body"></div><footer class="preview-dialog-actions"><span class="sample-description">PDF gerado pelo diálogo de impressão do navegador.</span><button class="tool-button primary-tool" id="preview-save-pdf" type="button">Imprimir / salvar PDF</button></footer></section></div>');

    panel.querySelectorAll(".save-profile").forEach((button) => button.addEventListener("click", () => {
      saveProfile(button.closest(".profile-group")).catch((error) => feedback(`Não foi possível salvar o cadastro: ${error.message}`, "error"));
    }));
    panel.querySelector("#cloud-login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = document.getElementById("cloud-login-button");
      const help = document.getElementById("cloud-auth-help");
      button.disabled = true;
      help.textContent = "Conectando ao banco D1…";
      try {
        const email = form.elements.email.value.trim();
        const password = form.elements.password.value;
        if (password.length < 12 || password.length > 256) throw new Error("A senha deve ter entre 12 e 256 caracteres.");
        const challenge = await apiRequest("/auth/challenge", { method: "POST", body: JSON.stringify({ email }) });
        const proof = await createLoginProof(password, challenge);
        const result = await apiRequest("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, challengeId: challenge.challengeId, proof })
        });
        sessionToken = result.token;
        sessionStorage.setItem("oficina-xml.session.v1", sessionToken);
        form.reset();
        await activateSession(result.user);
      } catch (error) {
        sessionToken = "";
        sessionStorage.removeItem("oficina-xml.session.v1");
        help.textContent = `Não foi possível entrar: ${error.message}`;
        help.dataset.state = "error";
      } finally {
        button.disabled = false;
      }
    });
    panel.querySelector("#cloud-logout").addEventListener("click", async () => {
      if (isSavingDocument) {
        feedback("Aguarde a sincronização do rascunho antes de sair.", "pending");
        return;
      }
      if (isDirty && !window.confirm("Há alterações pendentes. Sair sem sincronizá-las?")) return;
      clearTimeout(autoSaveTimer);
      try {
        await apiRequest("/auth/logout", { method: "POST", body: "{}" });
        sessionToken = "";
        sessionStorage.removeItem("oficina-xml.session.v1");
        clearInterval(sharedRefreshTimer);
        activeDocumentId = null;
        activeDocumentCreatedAt = null;
        assignedNumber = null;
        isDirty = false;
        document.getElementById("cloud-app").hidden = true;
        document.getElementById("cloud-login-form").hidden = false;
        document.getElementById("cloud-session").hidden = true;
        document.getElementById("database-status").textContent = "Desconectado";
      } catch (error) {
        feedback(`Não foi possível encerrar a sessão: ${error.message}`, "error");
      }
    });
    panel.querySelectorAll("select[data-list]").forEach((select) => select.addEventListener("change", () => {
      const record = catalog[select.dataset.list].find((item) => item.id === select.value);
      if (record) {
        writeGroup(select.closest(".profile-group"), record);
        isDirty = true;
        refreshDocument();
        scheduleAutoSave();
      }
    }));
    panel.querySelectorAll(".profile-group [name], .doc-fields input, .doc-fields select").forEach((input) => input.addEventListener("input", () => {
      isDirty = true;
      if (input.closest(".product-row")) updateProductsTotal();
      refreshDocument();
      scheduleAutoSave();
      if (input.closest(".profile-group")) scheduleProfileAutoSave(input.closest(".profile-group"));
    }));
    panel.querySelectorAll("[data-profile-search]").forEach((input) => input.addEventListener("input", refreshProfileSelects));
    panel.querySelector("#add-product").addEventListener("click", () => {
      const products = getProducts();
      products.push({ description: "", ncm: "", quantity: "1", unitPrice: "" });
      renderProducts(products);
      isDirty = true;
      refreshDocument();
      scheduleAutoSave();
      panel.querySelectorAll(".product-row [name=\"productDescription\"]")[products.length - 1].focus();
    });
    panel.querySelector("#product-list").addEventListener("click", (event) => {
      const button = event.target.closest(".remove-product");
      if (!button) return;
      const row = button.closest(".product-row");
      const index = [...panel.querySelectorAll(".product-row")].indexOf(row);
      const products = getProducts();
      products.splice(index, 1);
      renderProducts(products);
      isDirty = true;
      refreshDocument();
      scheduleAutoSave();
    });
    panel.querySelector("#product-list").addEventListener("input", () => {
      isDirty = true;
      updateProductsTotal();
      refreshDocument();
      scheduleAutoSave();
    });
    panel.querySelector("#product-catalog-search").addEventListener("input", renderProductCatalog);
    panel.querySelector("#saved-product-list").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-product-id]");
      if (!button) return;
      if (currentType() !== "nfe") {
        feedback("Abra uma NF-e para adicionar produtos salvos.", "pending");
        return;
      }
      try {
        const product = await getRecord("products", button.dataset.productId);
        if (!product) throw new Error("O produto não foi encontrado no catálogo local.");
        addCatalogProduct(product);
        setWorkflowStep(2);
        feedback(`${product.description} adicionado à nota.`, "ok");
      } catch (error) {
        feedback(`Não foi possível adicionar o produto: ${error.message}`, "error");
      }
    });
    panel.querySelectorAll(".doc-fields select[name$='Uf']").forEach((select) => select.addEventListener("change", () => loadMunicipalities(select.dataset.citySide, true)));
    panel.querySelectorAll(".doc-fields select[name$='Code']").forEach((select) => select.addEventListener("change", () => {
      isDirty = true;
      const name = select.dataset.citySide === "origin" ? "originName" : "destinationName";
      const nameInput = panel.querySelector(`input[name="${name}"]`);
      if (nameInput) nameInput.value = select.selectedOptions[0]?.textContent.toLocaleUpperCase("pt-BR") || "";
      refreshDocument();
      scheduleAutoSave();
    }));
    panel.querySelectorAll("[data-workflow-step], [data-next-step]").forEach((button) => button.addEventListener("click", () => setWorkflowStep(button.dataset.workflowStep || button.dataset.nextStep)));
    document.getElementById("reference-files").addEventListener("change", (event) => readReferenceFiles([...event.target.files]));
    document.getElementById("validate-schema").addEventListener("click", validateXml);
    document.getElementById("download-final-xml").addEventListener("click", downloadXml);
    document.getElementById("print-preview").addEventListener("click", showPrintPreview);
    document.getElementById("close-print-preview").addEventListener("click", closePrintPreview);
    document.getElementById("preview-save-pdf").addEventListener("click", () => { printContent(); window.print(); });
    document.getElementById("preview-overlay").addEventListener("click", (event) => { if (event.target.id === "preview-overlay") closePrintPreview(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !document.getElementById("preview-overlay").hidden) closePrintPreview(); });

    document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", (event) => {
      const selectedType = button.dataset.type;
      const reopening = loadingDocument;
      if (isSavingDocument && !reopening) {
        event.preventDefault();
        event.stopImmediatePropagation();
        feedback("Aguarde a conclusão do salvamento automático antes de trocar o tipo de documento.", "pending");
        return;
      }
      if (isDirty && !reopening && !window.confirm("Há alterações ainda não salvas. Descartá-las e trocar o tipo de documento?")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      clearTimeout(autoSaveTimer);
      isDirty = false;
      if (activeDocumentId) activeDocumentId = null;
      activeDocumentCreatedAt = null;
      assignedNumber = null;
      document.getElementById("generate-button").textContent = "Salvar rascunho numerado";
      setOperationDefaults(currentType());
      setTimeout(async () => {
        renderReferences();
        if (reopening) {
          updateDocumentFields();
          refreshDocument();
          return;
        }
        setOperationDefaults(selectedType);
        const counter = await getRecord("counters", selectedType).catch((error) => {
          feedback(`Não foi possível consultar a numeração compartilhada: ${error.message}`, "error");
          return null;
        });
        window.oficinaState.number = (counter?.number || 0) + 1;
        window.oficinaRender();
        updateDocumentFields();
        refreshDocument();
      }, 0);
    }), true);

    const oldGenerate = document.getElementById("generate-button");
    const newGenerate = oldGenerate.cloneNode(true);
    newGenerate.textContent = "Salvar rascunho numerado";
    newGenerate.addEventListener("click", () => saveCurrentDocument());
    oldGenerate.replaceWith(newGenerate);
    document.getElementById("new-document").addEventListener("click", () => {
      startNewDocument().catch((error) => feedback(`Não foi possível iniciar um documento: ${error.message}`, "error"));
    });
    document.getElementById("document-search").addEventListener("input", renderDocumentLibrary);

    const oldDownload = document.getElementById("download-button");
    const newDownload = oldDownload.cloneNode(true);
    newDownload.addEventListener("click", downloadXml);
    oldDownload.replaceWith(newDownload);

    refreshProfileSelects();
    setOperationDefaults(currentType());
    updateDocumentFields();
    refreshDocument();
    setWorkflowStep(1);
    renderDocumentLibrary();
    renderProductCatalog();
  }

  async function initialize() {
    bind();
    try {
      await initializeCloudflare();
    } catch (error) {
      document.getElementById("database-status").textContent = "API indisponível";
      document.getElementById("database-status").dataset.state = "error";
      document.getElementById("cloud-auth-help").textContent = `Não foi possível iniciar o banco compartilhado: ${error.message}`;
      document.getElementById("cloud-auth-help").dataset.state = "error";
      document.getElementById("generate-button").disabled = true;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
