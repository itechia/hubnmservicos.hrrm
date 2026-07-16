const SearchableSelect = {
  selector: [
    '#filter-sala',
    '#report-sala',
    '#filter-centro-custo',
    '#alertas-centro-custo',
    '#report-centro-custo',
  ].join(','),

  enhanceAll() {
    document.querySelectorAll(this.selector).forEach(select => this.enhance(select));
    this.syncAll();
  },

  syncAll() {
    document.querySelectorAll('[data-searchable-ready="true"]').forEach(select => this.sync(select));
  },

  enhance(select) {
    if (!select || select.dataset.searchableReady === 'true') return;

    const wrapper = document.createElement('div');
    wrapper.className = 'searchable-select searchable-select-closed';
    select.parentNode.insertBefore(wrapper, select);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'searchable-select-trigger';
    button.innerHTML = `
      <span class="searchable-select-value"></span>
      <span class="searchable-select-arrow">⌄</span>
    `;

    const panel = document.createElement('div');
    panel.className = 'searchable-select-panel';
    panel.innerHTML = `
      <div class="searchable-select-search">
        <span class="searchable-select-icon">🔎</span>
        <input type="search" class="searchable-select-input" autocomplete="off">
      </div>
      <div class="searchable-select-options"></div>
    `;

    wrapper.append(button, panel, select);
    select.dataset.searchableReady = 'true';

    const input = panel.querySelector('.searchable-select-input');
    input.placeholder = select.id.includes('sala') ? 'Pesquisar sala...' : 'Pesquisar centro...';

    const open = () => {
      this.closeAll(wrapper);
      wrapper.classList.remove('searchable-select-closed');
      wrapper.classList.add('searchable-select-open');
      this.renderOptions(select);
      setTimeout(() => input.focus(), 0);
    };

    const close = () => {
      wrapper.classList.remove('searchable-select-open');
      wrapper.classList.add('searchable-select-closed');
      input.value = '';
      this.renderOptions(select);
    };

    button.addEventListener('click', () => {
      if (wrapper.classList.contains('searchable-select-open')) close();
      else open();
    });

    input.addEventListener('input', () => this.renderOptions(select));
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Enter') return;
      const firstOption = panel.querySelector('.searchable-select-option:not(.is-empty)');
      if (firstOption) firstOption.click();
    });

    select.addEventListener('change', () => {
      this.sync(select);
      close();
    });

    document.addEventListener('click', event => {
      if (!wrapper.contains(event.target)) close();
    });

    this.sync(select);
    this.renderOptions(select);
  },

  closeAll(exceptWrapper = null) {
    document.querySelectorAll('.searchable-select-open').forEach(wrapper => {
      if (wrapper === exceptWrapper) return;
      wrapper.classList.remove('searchable-select-open');
      wrapper.classList.add('searchable-select-closed');
      const input = wrapper.querySelector('.searchable-select-input');
      if (input) input.value = '';
    });
  },

  renderOptions(select) {
    const wrapper = select.closest('.searchable-select');
    if (!wrapper) return;

    const input = wrapper.querySelector('.searchable-select-input');
    const optionsContainer = wrapper.querySelector('.searchable-select-options');
    const term = this.normalize(input?.value);
    const options = [...select.options].filter(option => {
      if (!term) return true;
      return this.normalize(option.textContent).includes(term) || this.normalize(option.value).includes(term);
    });

    optionsContainer.innerHTML = '';

    if (!options.length) {
      const empty = document.createElement('div');
      empty.className = 'searchable-select-option is-empty';
      empty.textContent = 'Nenhum resultado encontrado';
      optionsContainer.append(empty);
      return;
    }

    options.forEach(option => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `searchable-select-option${option.value === select.value ? ' is-selected' : ''}`;
      item.textContent = option.textContent;
      item.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      optionsContainer.append(item);
    });
  },

  sync(select) {
    const wrapper = select.closest('.searchable-select');
    const value = wrapper?.querySelector('.searchable-select-value');
    if (!value) return;
    value.textContent = select.options[select.selectedIndex]?.textContent || 'Selecionar';
  },

  normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  },
};
