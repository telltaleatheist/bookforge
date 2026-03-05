/**
 * BookForge Library Manager
 * Client-side JavaScript for browsing and downloading audiobooks and ebooks
 */

class LibraryManager {
  constructor() {
    this.allBooks = [];
    this.allEbooks = [];
    this.loadedCovers = new Set();
    this.coverLoadQueue = [];
    this.isLoadingCovers = false;
    this.currentTab = 'audiobooks';
    this.currentSort = localStorage.getItem('library-sort') || 'title';
    this.currentCategory = 'all';

    // DOM elements
    this.booksContainer = document.getElementById('books-container');
    this.loadingIndicator = document.getElementById('loading-indicator');
    this.emptyState = document.getElementById('empty-state');
    this.searchBox = document.getElementById('search-box');
    this.clearSearch = document.getElementById('clear-search');
    this.loadStatus = document.getElementById('load-status');
    this.totalBooks = document.getElementById('total-books');
    this.statLabel = document.getElementById('stat-label');
    this.themeToggle = document.getElementById('theme-toggle');
    this.tabAudiobooks = document.getElementById('tab-audiobooks');
    this.tabEbooks = document.getElementById('tab-ebooks');
    this.sortTitle = document.getElementById('sort-title');
    this.sortDate = document.getElementById('sort-date');
    this.categoryBar = document.getElementById('category-bar');
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
    this.applySortToggleState();
    await this.loadBooks();
  }

  setupTheme() {
    const savedTheme = localStorage.getItem('library-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('library-theme', next);
  }

  setupEventListeners() {
    this.themeToggle.addEventListener('click', () => this.toggleTheme());

    this.searchBox.addEventListener('input', () => this.filterBooks());
    this.clearSearch.addEventListener('click', () => {
      this.searchBox.value = '';
      this.clearSearch.style.display = 'none';
      this.filterBooks();
    });

    // Tab toggle
    this.tabAudiobooks.addEventListener('click', () => this.switchTab('audiobooks'));
    this.tabEbooks.addEventListener('click', () => this.switchTab('ebooks'));

    // Sort toggle
    this.sortTitle.addEventListener('click', () => this.setSort('title'));
    this.sortDate.addEventListener('click', () => this.setSort('date'));
  }

  applySortToggleState() {
    this.sortTitle.classList.toggle('active', this.currentSort === 'title');
    this.sortDate.classList.toggle('active', this.currentSort === 'date');
  }

  setSort(sort) {
    this.currentSort = sort;
    localStorage.setItem('library-sort', sort);
    this.applySortToggleState();

    if (this.currentTab === 'audiobooks') {
      this.sortBooks();
      this.renderAudiobooks();
      this.loadCoversProgressively();
    } else {
      this.sortEbooks();
      this.renderEbooks();
      this.loadEbookCoversProgressively();
    }
  }

  sortBooks() {
    if (this.currentSort === 'date') {
      this.allBooks.sort((a, b) => {
        const da = a.dateAdded || '';
        const db = b.dateAdded || '';
        return db.localeCompare(da); // newest first
      });
    } else {
      this.allBooks.sort((a, b) => a.title.localeCompare(b.title));
    }
  }

  sortEbooks() {
    if (this.currentSort === 'date') {
      this.allEbooks.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
    } else {
      this.allEbooks.sort((a, b) => a.title.localeCompare(b.title));
    }
  }

  buildCategoryBar() {
    const categories = new Map();
    for (const book of this.allEbooks) {
      const cat = book.category || 'Uncategorized';
      categories.set(cat, (categories.get(cat) || 0) + 1);
    }

    this.categoryBar.innerHTML = '';

    // "All" pill
    const allBtn = document.createElement('button');
    allBtn.className = 'category-pill' + (this.currentCategory === 'all' ? ' active' : '');
    allBtn.dataset.category = 'all';
    allBtn.textContent = `All (${this.allEbooks.length})`;
    allBtn.addEventListener('click', () => this.setCategory('all'));
    this.categoryBar.appendChild(allBtn);

    // Sort categories: Uncategorized last, rest alphabetical
    const sorted = [...categories.entries()].sort((a, b) => {
      if (a[0] === 'Uncategorized') return 1;
      if (b[0] === 'Uncategorized') return -1;
      return a[0].localeCompare(b[0]);
    });

    for (const [name, count] of sorted) {
      const btn = document.createElement('button');
      btn.className = 'category-pill' + (this.currentCategory === name ? ' active' : '');
      btn.dataset.category = name;
      btn.textContent = `${name} (${count})`;
      btn.addEventListener('click', () => this.setCategory(name));
      this.categoryBar.appendChild(btn);
    }

    this.categoryBar.style.display = 'flex';
  }

  setCategory(category) {
    this.currentCategory = category;

    // Update active state on pills
    this.categoryBar.querySelectorAll('.category-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.category === category);
    });

    this.renderEbooks();
    this.loadEbookCoversProgressively();
  }

  async switchTab(tab) {
    this.currentTab = tab;

    // Update tab buttons
    this.tabAudiobooks.classList.toggle('active', tab === 'audiobooks');
    this.tabEbooks.classList.toggle('active', tab === 'ebooks');

    // Update search placeholder
    this.searchBox.placeholder = tab === 'audiobooks' ? 'Search audiobooks...' : 'Search ebooks...';
    this.searchBox.value = '';
    this.clearSearch.style.display = 'none';

    // Show/hide category bar
    this.categoryBar.style.display = tab === 'ebooks' ? 'flex' : 'none';

    if (tab === 'ebooks') {
      if (this.allEbooks.length === 0) {
        await this.loadEbooks();
      } else {
        this.renderEbooks();
      }
    } else {
      this.currentCategory = 'all';
      if (this.allBooks.length === 0) {
        await this.loadBooks();
      } else {
        this.renderAudiobooks();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Audiobooks
  // ─────────────────────────────────────────────────────────────────────────────

  async loadBooks() {
    try {
      this.loadingIndicator.style.display = 'flex';
      this.emptyState.style.display = 'none';

      const response = await fetch('/api/books');
      const data = await response.json();

      this.allBooks = data.books || [];
      this.totalBooks.textContent = this.allBooks.length;
      this.statLabel.textContent = 'Audiobooks';

      if (this.allBooks.length === 0) {
        this.loadingIndicator.style.display = 'none';
        this.emptyState.style.display = 'flex';
        return;
      }

      this.sortBooks();
      this.renderAudiobooks();
      this.loadingIndicator.style.display = 'none';

      this.loadCoversProgressively();
    } catch (err) {
      console.error('Failed to load books:', err);
      this.loadStatus.textContent = 'Error loading library';
      this.loadingIndicator.style.display = 'none';
    }
  }

  renderAudiobooks() {
    this.booksContainer.innerHTML = '';
    this.coverLoadQueue = [];
    this.totalBooks.textContent = this.allBooks.length;
    this.statLabel.textContent = 'Audiobooks';

    this.allBooks.forEach((book, index) => {
      const card = this.createAudiobookCard(book, index);
      this.booksContainer.appendChild(card);
    });

    if (this.allBooks.length === 0) {
      this.emptyState.style.display = 'flex';
    } else {
      this.emptyState.style.display = 'none';
    }
  }

  createAudiobookCard(book, delay = 0) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.style.animationDelay = `${delay * 0.03}s`;
    card.dataset.projectId = book.projectId;
    card.dataset.downloadPath = book.downloadPath;
    card.dataset.title = (book.title || '').toLowerCase();
    card.dataset.author = (book.author || '').toLowerCase();

    const typeLabel = book.type === 'bilingual'
      ? `bilingual ${book.langPair || ''}`
      : 'audiobook';

    const durationStr = book.duration ? this.formatDuration(book.duration) : '';
    const sizeAndDuration = durationStr
      ? `${this.formatSize(book.size)} &middot; ${durationStr}`
      : this.formatSize(book.size);

    card.innerHTML = `
      <div class="book-cover">
        <span class="placeholder">🎧</span>
        <span class="book-type-badge m4b">${this.escapeHtml(typeLabel)}</span>
      </div>
      <div class="book-info">
        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
        ${book.author ? `<div class="book-author">${this.escapeHtml(book.author)}</div>` : ''}
        <div class="book-size">${sizeAndDuration}</div>
      </div>
    `;

    card.addEventListener('click', () => this.downloadAudiobook(book));

    this.coverLoadQueue.push({ card, book });

    return card;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Ebooks
  // ─────────────────────────────────────────────────────────────────────────────

  async loadEbooks() {
    try {
      this.loadingIndicator.style.display = 'flex';
      this.emptyState.style.display = 'none';

      const response = await fetch('/api/ebooks');
      const data = await response.json();

      this.allEbooks = data.ebooks || [];

      if (this.allEbooks.length === 0) {
        this.totalBooks.textContent = '0';
        this.statLabel.textContent = 'Ebooks';
        this.loadingIndicator.style.display = 'none';
        this.emptyState.style.display = 'flex';
        return;
      }

      this.sortEbooks();
      this.buildCategoryBar();
      this.renderEbooks();
      this.loadingIndicator.style.display = 'none';

      this.loadEbookCoversProgressively();
    } catch (err) {
      console.error('Failed to load ebooks:', err);
      this.loadStatus.textContent = 'Error loading ebooks';
      this.loadingIndicator.style.display = 'none';
    }
  }

  renderEbooks() {
    this.booksContainer.innerHTML = '';
    this.statLabel.textContent = 'Ebooks';

    const filtered = this.currentCategory === 'all'
      ? this.allEbooks
      : this.allEbooks.filter(b => b.category === this.currentCategory);

    this.totalBooks.textContent = filtered.length;

    filtered.forEach((book, index) => {
      const card = this.createEbookCard(book, index);
      this.booksContainer.appendChild(card);
    });

    if (filtered.length === 0) {
      this.emptyState.style.display = 'flex';
    } else {
      this.emptyState.style.display = 'none';
    }
  }

  createEbookCard(book, delay = 0) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.style.animationDelay = `${delay * 0.03}s`;
    card.dataset.relativePath = book.relativePath;
    card.dataset.title = (book.title || '').toLowerCase();
    card.dataset.author = (book.authorFull || book.authorLast || '').toLowerCase();

    const format = (book.format || 'epub').toUpperCase();
    const formatClass = `format-${book.format}`;
    const author = book.authorFull || (book.authorLast ? `${book.authorLast}, ${book.authorFirst || ''}`.trim() : '');

    card.innerHTML = `
      <div class="book-cover">
        <span class="placeholder">📖</span>
        <span class="book-type-badge ${formatClass}">${format}</span>
      </div>
      <div class="book-info">
        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
        ${author ? `<div class="book-author">${this.escapeHtml(author)}</div>` : ''}
        <div class="book-size">${this.formatSize(book.fileSize)}${book.year ? ` &middot; ${book.year}` : ''}</div>
      </div>
    `;

    card.addEventListener('click', () => this.downloadEbook(book));

    return card;
  }

  async loadEbookCoversProgressively() {
    const cards = this.booksContainer.querySelectorAll('.book-card');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          const relativePath = card.dataset.relativePath;
          if (relativePath && !this.loadedCovers.has(relativePath)) {
            this.loadEbookCover(card, relativePath);
            this.loadedCovers.add(relativePath);
          }
          observer.unobserve(card);
        }
      });
    }, { rootMargin: '100px', threshold: 0 });

    cards.forEach(card => observer.observe(card));
  }

  async loadEbookCover(card, relativePath) {
    try {
      const response = await fetch(`/api/ebook-cover?path=${encodeURIComponent(relativePath)}`);
      const data = await response.json();

      if (data.cover) {
        const coverEl = card.querySelector('.book-cover');
        const img = document.createElement('img');
        img.src = data.cover;
        img.alt = 'Cover';
        img.loading = 'lazy';

        const placeholder = coverEl.querySelector('.placeholder');
        if (placeholder) {
          placeholder.style.display = 'none';
        }
        coverEl.insertBefore(img, coverEl.firstChild);
      }
    } catch (err) {
      console.error('Failed to load ebook cover:', err);
    }
  }

  downloadEbook(book) {
    const url = `/api/ebook-download?path=${encodeURIComponent(book.relativePath)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = book.filename || 'book';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Shared
  // ─────────────────────────────────────────────────────────────────────────────

  async loadCoversProgressively() {
    if (this.isLoadingCovers || this.coverLoadQueue.length === 0) return;
    this.isLoadingCovers = true;

    const cardDataMap = new Map();
    this.coverLoadQueue.forEach(({ card, book }) => {
      cardDataMap.set(card, book);
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          const book = cardDataMap.get(card);

          if (book && !this.loadedCovers.has(book.downloadPath)) {
            this.loadCover(card, book);
            this.loadedCovers.add(book.downloadPath);
          }

          observer.unobserve(card);
        }
      });
    }, {
      rootMargin: '100px',
      threshold: 0
    });

    this.coverLoadQueue.forEach(({ card }) => {
      observer.observe(card);
    });

    this.isLoadingCovers = false;
  }

  async loadCover(card, book) {
    try {
      const params = new URLSearchParams();
      if (book.projectId) params.set('projectId', book.projectId);
      if (book.downloadPath) params.set('downloadPath', book.downloadPath);

      const response = await fetch(`/api/cover?${params.toString()}`);
      const data = await response.json();

      if (data.cover) {
        const coverEl = card.querySelector('.book-cover');
        const img = document.createElement('img');
        img.src = data.cover;
        img.alt = 'Cover';
        img.loading = 'lazy';

        const placeholder = coverEl.querySelector('.placeholder');
        if (placeholder) {
          placeholder.style.display = 'none';
        }
        coverEl.insertBefore(img, coverEl.firstChild);
      }
    } catch (err) {
      console.error('Failed to load cover:', book.title, err);
    }
  }

  filterBooks() {
    const query = this.searchBox.value.toLowerCase().trim();
    this.clearSearch.style.display = query ? 'block' : 'none';

    const cards = this.booksContainer.querySelectorAll('.book-card');
    let totalVisible = 0;

    cards.forEach(card => {
      const title = card.dataset.title;
      const author = card.dataset.author;
      const matches = !query || title.includes(query) || author.includes(query);
      card.style.display = matches ? '' : 'none';
      if (matches) totalVisible++;
    });

    this.emptyState.style.display = totalVisible === 0 ? 'flex' : 'none';
  }

  downloadAudiobook(book) {
    const displayName = book.outputFilename || book.downloadPath.split(/[/\\]/).pop() || 'audiobook.m4b';
    const url = `/api/download?path=${encodeURIComponent(book.downloadPath)}&filename=${encodeURIComponent(displayName)}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = displayName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    return `${m}m`;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const library = new LibraryManager();
  library.init();
});
