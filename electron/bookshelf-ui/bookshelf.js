/**
 * BookForge Bookshelf — Web UI for browsing and downloading audiobooks
 *
 * This is the remote-accessible web interface (HTTP server).
 * Not to be confused with the Angular Library (ebook catalog) or Studio (TTS pipeline).
 */

class BookshelfManager {
  constructor() {
    this.allBooks = [];
    this.allEbooks = [];
    this.loadedCovers = new Set();
    this.coverLoadQueue = [];
    this.isLoadingCovers = false;
    this.currentTab = 'audiobooks';
    this.currentSort = localStorage.getItem('bookshelf-sort') || 'title';
    this.currentCategory = 'all';
    this.audiobookTags = [];
    this.currentAudiobookTag = 'all';
    this.ebookTags = [];
    this.currentEbookTag = 'all';

    // Queue state
    this.queuePollTimer = null;
    this.showCompleted = false;
    this.expandedWorkflows = new Set();

    // Audio player state
    this.audioEl = document.getElementById('audio-element');
    this.currentTrack = null; // { book, coverDataUrl }
    this.isSeeking = false;

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
    this.tabQueue = document.getElementById('tab-queue');
    this.sortTitle = document.getElementById('sort-title');
    this.sortDate = document.getElementById('sort-date');
    this.categoryBar = document.getElementById('category-bar');
    this.ebookTagBar = document.getElementById('ebook-tag-bar');

    // Section containers
    this.bookshelfBar = document.getElementById('bookshelf-bar');
    this.refreshBtn = document.getElementById('refresh-btn');
    this.searchContainer = document.getElementById('search-container');
    this.bookshelfContent = document.getElementById('bookshelf-content');
    this.queueContent = document.getElementById('queue-content');

    // Player elements
    this.playerBar = document.getElementById('player-bar');
    this.playerCover = document.getElementById('player-cover');
    this.playerTitle = document.getElementById('player-title');
    this.playerAuthor = document.getElementById('player-author');
    this.playerPlayBtn = document.getElementById('player-play-btn');
    this.playerSeek = document.getElementById('player-seek');
    this.playerCurrentTime = document.getElementById('player-current-time');
    this.playerDuration = document.getElementById('player-duration');
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
    this.setupPlayerListeners();
    this.applySortToggleState();
    await this.loadBooks();
  }

  setupTheme() {
    const savedTheme = localStorage.getItem('bookshelf-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('bookshelf-theme', next);
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
    this.tabQueue.addEventListener('click', () => this.switchTab('queue'));

    // Refresh button
    this.refreshBtn.addEventListener('click', () => this.refreshBooks());

    // Sort toggle
    this.sortTitle.addEventListener('click', () => this.setSort('title'));
    this.sortDate.addEventListener('click', () => this.setSort('date'));

    // Queue show-completed toggle
    document.getElementById('queue-show-completed').addEventListener('change', (e) => {
      this.showCompleted = e.target.checked;
      this.renderQueue(this._lastQueueData);
    });

    // Queue start/pause controls
    document.getElementById('queue-start-btn').addEventListener('click', () => this.sendQueueControl('start'));
    document.getElementById('queue-pause-btn').addEventListener('click', () => this.sendQueueControl('pause'));
  }

  setupPlayerListeners() {
    // Play/pause button
    this.playerPlayBtn.addEventListener('click', () => this.togglePlayPause());

    // Seek bar interaction
    this.playerSeek.addEventListener('input', () => {
      this.isSeeking = true;
      const t = (this.playerSeek.value / 100) * (this.audioEl.duration || 0);
      this.playerCurrentTime.textContent = this.formatTime(t);
    });
    this.playerSeek.addEventListener('change', () => {
      const t = (this.playerSeek.value / 100) * (this.audioEl.duration || 0);
      this.audioEl.currentTime = t;
      this.isSeeking = false;
    });

    // Audio element events
    this.audioEl.addEventListener('timeupdate', () => {
      if (this.isSeeking) return;
      const dur = this.audioEl.duration || 0;
      const cur = this.audioEl.currentTime || 0;
      this.playerCurrentTime.textContent = this.formatTime(cur);
      if (dur > 0) {
        this.playerSeek.value = (cur / dur) * 100;
      }
      // Save position for resume
      if (this.currentTrack) {
        localStorage.setItem('player-position', JSON.stringify({
          downloadPath: this.currentTrack.book.downloadPath,
          time: cur,
        }));
      }
    });

    this.audioEl.addEventListener('loadedmetadata', () => {
      this.playerDuration.textContent = this.formatTime(this.audioEl.duration);
      this.playerSeek.max = 100;
      // Restore saved position if same track
      const saved = this.getSavedPosition();
      if (saved && this.currentTrack && saved.downloadPath === this.currentTrack.book.downloadPath) {
        this.audioEl.currentTime = saved.time;
      }
    });

    this.audioEl.addEventListener('play', () => this.updatePlayPauseUI(true));
    this.audioEl.addEventListener('pause', () => this.updatePlayPauseUI(false));
    this.audioEl.addEventListener('ended', () => this.updatePlayPauseUI(false));
  }

  applySortToggleState() {
    this.sortTitle.classList.toggle('active', this.currentSort === 'title');
    this.sortDate.classList.toggle('active', this.currentSort === 'date');
  }

  setSort(sort) {
    this.currentSort = sort;
    localStorage.setItem('bookshelf-sort', sort);
    this.applySortToggleState();

    if (this.currentTab === 'audiobooks') {
      this.sortBooks();
      this.renderAudiobooks();
      this.loadCoversProgressively();
    } else if (this.currentTab === 'ebooks') {
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

  buildAudiobookTagBar() {
    const tagSet = new Set();
    for (const book of this.allBooks) {
      if (book.tags) {
        for (const t of book.tags) tagSet.add(t);
      }
    }
    this.audiobookTags = [...tagSet].sort();

    if (this.audiobookTags.length === 0) {
      this.categoryBar.style.display = 'none';
      return;
    }

    this.categoryBar.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.className = 'category-pill' + (this.currentAudiobookTag === 'all' ? ' active' : '');
    allBtn.dataset.tag = 'all';
    allBtn.textContent = `All (${this.allBooks.length})`;
    allBtn.addEventListener('click', () => this.setAudiobookTag('all'));
    this.categoryBar.appendChild(allBtn);

    for (const tag of this.audiobookTags) {
      const count = this.allBooks.filter(b => b.tags && b.tags.includes(tag)).length;
      const btn = document.createElement('button');
      btn.className = 'category-pill' + (this.currentAudiobookTag === tag ? ' active' : '');
      btn.dataset.tag = tag;
      btn.textContent = `${tag} (${count})`;
      btn.addEventListener('click', () => this.setAudiobookTag(tag));
      this.categoryBar.appendChild(btn);
    }

    this.categoryBar.style.display = 'flex';
  }

  setAudiobookTag(tag) {
    this.currentAudiobookTag = tag;

    this.categoryBar.querySelectorAll('.category-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tag === tag);
    });

    this.renderAudiobooks();
    this.loadCoversProgressively();
  }

  setCategory(category) {
    this.currentCategory = category;
    this.currentEbookTag = 'all';

    // Update active state on pills
    this.categoryBar.querySelectorAll('.category-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.category === category);
    });

    this.buildEbookTagBar();
    this.renderEbooks();
    this.loadEbookCoversProgressively();
  }

  buildEbookTagBar() {
    // Collect tags from ebooks within current category
    const booksInCategory = this.currentCategory === 'all'
      ? this.allEbooks
      : this.allEbooks.filter(b => b.category === this.currentCategory);

    const tagCounts = new Map();
    for (const book of booksInCategory) {
      if (book.tags) {
        for (const t of book.tags) {
          tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        }
      }
    }

    this.ebookTags = [...tagCounts.keys()].sort();

    if (this.ebookTags.length === 0) {
      this.ebookTagBar.style.display = 'none';
      return;
    }

    this.ebookTagBar.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.className = 'category-pill' + (this.currentEbookTag === 'all' ? ' active' : '');
    allBtn.dataset.tag = 'all';
    allBtn.textContent = `All Tags`;
    allBtn.addEventListener('click', () => this.setEbookTag('all'));
    this.ebookTagBar.appendChild(allBtn);

    for (const tag of this.ebookTags) {
      const count = tagCounts.get(tag);
      const btn = document.createElement('button');
      btn.className = 'category-pill' + (this.currentEbookTag === tag ? ' active' : '');
      btn.dataset.tag = tag;
      btn.textContent = `${tag} (${count})`;
      btn.addEventListener('click', () => this.setEbookTag(tag));
      this.ebookTagBar.appendChild(btn);
    }

    this.ebookTagBar.style.display = 'flex';
  }

  setEbookTag(tag) {
    this.currentEbookTag = tag;

    this.ebookTagBar.querySelectorAll('.category-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tag === tag);
    });

    this.renderEbooks();
    this.loadEbookCoversProgressively();
  }

  async switchTab(tab) {
    this.currentTab = tab;

    // Update tab buttons
    this.tabAudiobooks.classList.toggle('active', tab === 'audiobooks');
    this.tabEbooks.classList.toggle('active', tab === 'ebooks');
    this.tabQueue.classList.toggle('active', tab === 'queue');

    // Stop queue polling if leaving queue tab
    if (tab !== 'queue') {
      this.stopQueuePolling();
    }

    if (tab === 'queue') {
      // Hide library UI, show queue
      this.bookshelfBar.style.display = 'none';
      this.searchContainer.style.display = 'none';
      this.categoryBar.style.display = 'none';
      this.ebookTagBar.style.display = 'none';
      this.bookshelfContent.style.display = 'none';
      this.queueContent.style.display = 'block';
      this.startQueuePolling();
    } else {
      // Show library UI, hide queue
      this.bookshelfBar.style.display = 'flex';
      this.searchContainer.style.display = 'block';
      this.bookshelfContent.style.display = 'block';
      this.queueContent.style.display = 'none';

      // Update search placeholder
      this.searchBox.placeholder = tab === 'audiobooks' ? 'Search audiobooks...' : 'Search ebooks...';
      this.searchBox.value = '';
      this.clearSearch.style.display = 'none';

      if (tab === 'ebooks') {
        this.ebookTagBar.style.display = 'none';
        this.currentEbookTag = 'all';
        this.buildCategoryBar();
        this.buildEbookTagBar();
        if (this.allEbooks.length === 0) {
          await this.loadEbooks();
        } else {
          this.renderEbooks();
        }
      } else {
        this.currentCategory = 'all';
        this.currentEbookTag = 'all';
        this.ebookTagBar.style.display = 'none';
        this.buildAudiobookTagBar();
        if (this.allBooks.length === 0) {
          await this.loadBooks();
        } else {
          this.renderAudiobooks();
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Audiobooks
  // ─────────────────────────────────────────────────────────────────────────────

  async loadBooks(forceRefresh = false) {
    try {
      this.loadingIndicator.style.display = 'flex';
      this.emptyState.style.display = 'none';

      const url = forceRefresh ? '/api/books?refresh=true' : '/api/books';
      const response = await fetch(url);
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
      this.buildAudiobookTagBar();
      this.renderAudiobooks();
      this.loadingIndicator.style.display = 'none';

      this.loadCoversProgressively();
    } catch (err) {
      console.error('Failed to load books:', err);
      this.loadStatus.textContent = 'Error loading bookshelf';
      this.loadingIndicator.style.display = 'none';
    }
  }

  async refreshBooks() {
    this.refreshBtn.classList.add('spinning');
    if (this.currentTab === 'audiobooks') {
      await this.loadBooks(true);
    } else if (this.currentTab === 'ebooks') {
      await this.loadEbooks(true);
    }
    this.refreshBtn.classList.remove('spinning');
  }

  renderAudiobooks() {
    this.booksContainer.innerHTML = '';
    this.coverLoadQueue = [];
    this.loadedCovers.clear();
    this.isLoadingCovers = false;
    this.statLabel.textContent = 'Audiobooks';

    const filtered = this.currentAudiobookTag === 'all'
      ? this.allBooks
      : this.allBooks.filter(b => b.tags && b.tags.includes(this.currentAudiobookTag));

    this.totalBooks.textContent = filtered.length;

    filtered.forEach((book, index) => {
      const card = this.createAudiobookCard(book, index);
      this.booksContainer.appendChild(card);
    });

    if (filtered.length === 0) {
      this.emptyState.style.display = 'flex';
    } else {
      this.emptyState.style.display = 'none';
    }
  }

  createAudiobookCard(book, delay = 0) {
    const card = document.createElement('div');
    card.className = 'book-card' + (book.source === 'external' ? ' external' : '');
    card.style.animationDelay = `${delay * 0.03}s`;
    card.dataset.projectId = book.projectId;
    card.dataset.downloadPath = book.downloadPath;
    card.dataset.title = (book.title || '').toLowerCase();
    card.dataset.author = (book.author || '').toLowerCase();
    card.dataset.tags = (book.tags || []).join(',').toLowerCase();

    const typeLabel = book.source === 'external'
      ? 'imported'
      : (book.type === 'bilingual' ? `bilingual ${book.langPair || ''}` : 'audiobook');

    const durationStr = book.duration ? this.formatDuration(book.duration) : '';
    const sizeAndDuration = durationStr
      ? `${this.formatSize(book.size)} &middot; ${durationStr}`
      : this.formatSize(book.size);

    // Check if this book is currently playing
    const isPlaying = this.currentTrack &&
      this.currentTrack.book.downloadPath === book.downloadPath &&
      !this.audioEl.paused;

    const tagsHtml = (book.tags && book.tags.length > 0)
      ? `<div class="book-tags">${book.tags.slice(0, 3).map(t => `<span class="book-tag">${this.escapeHtml(t)}</span>`).join('')}${book.tags.length > 3 ? `<span class="book-tag book-tag-more">+${book.tags.length - 3}</span>` : ''}</div>`
      : '';

    card.innerHTML = `
      <div class="book-cover">
        <span class="placeholder">🎧</span>
        <span class="book-type-badge m4b">${this.escapeHtml(typeLabel)}</span>
        <button class="card-play-btn${isPlaying ? ' is-playing' : ''}" data-download-path="${this.escapeHtml(book.downloadPath)}" title="Play">
          <svg viewBox="0 0 24 24" width="16" height="16"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>
        </button>
      </div>
      <div class="book-info">
        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
        ${book.author ? `<div class="book-author">${this.escapeHtml(book.author)}</div>` : ''}
        ${tagsHtml}
        <div class="book-size">${sizeAndDuration}</div>
      </div>
    `;

    // Play button click — stop propagation so card click (download) doesn't fire
    const playBtn = card.querySelector('.card-play-btn');
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.playBook(book, card);
    });

    card.addEventListener('click', () => this.downloadAudiobook(book));

    this.coverLoadQueue.push({ card, book });

    return card;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Ebooks
  // ─────────────────────────────────────────────────────────────────────────────

  async loadEbooks(forceRefresh = false) {
    try {
      this.loadingIndicator.style.display = 'flex';
      this.emptyState.style.display = 'none';

      const url = forceRefresh ? '/api/ebooks?refresh=true' : '/api/ebooks';
      const response = await fetch(url);
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
      this.buildEbookTagBar();
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
    this.loadedCovers.clear();
    this.statLabel.textContent = 'Ebooks';

    let filtered = this.currentCategory === 'all'
      ? this.allEbooks
      : this.allEbooks.filter(b => b.category === this.currentCategory);

    if (this.currentEbookTag !== 'all') {
      filtered = filtered.filter(b => b.tags && b.tags.includes(this.currentEbookTag));
    }

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
    card.dataset.tags = (book.tags || []).join(',').toLowerCase();

    const format = (book.format || 'epub').toUpperCase();
    const formatClass = `format-${book.format}`;
    const author = book.authorFull || (book.authorLast ? `${book.authorLast}, ${book.authorFirst || ''}`.trim() : '');

    const tagsHtml = (book.tags && book.tags.length > 0)
      ? `<div class="book-tags">${book.tags.slice(0, 3).map(t => `<span class="book-tag">${this.escapeHtml(t)}</span>`).join('')}${book.tags.length > 3 ? `<span class="book-tag book-tag-more">+${book.tags.length - 3}</span>` : ''}</div>`
      : '';

    card.innerHTML = `
      <div class="book-cover">
        <span class="placeholder">📖</span>
        <span class="book-type-badge ${formatClass}">${format}</span>
      </div>
      <div class="book-info">
        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
        ${author ? `<div class="book-author">${this.escapeHtml(author)}</div>` : ''}
        ${tagsHtml}
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

        img.onload = () => {
          const ratio = img.naturalWidth / img.naturalHeight;
          if (ratio > 0.85) {
            coverEl.classList.add('square-cover');
          }
        };

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
  // Queue Tab
  // ─────────────────────────────────────────────────────────────────────────────

  startQueuePolling() {
    this.fetchQueue(); // immediate first load
    this.queuePollTimer = setInterval(() => this.fetchQueue(), 3000);
  }

  stopQueuePolling() {
    if (this.queuePollTimer) {
      clearInterval(this.queuePollTimer);
      this.queuePollTimer = null;
    }
  }

  async fetchQueue() {
    try {
      const response = await fetch('/api/queue');
      const data = await response.json();
      this._lastQueueData = data;
      this.renderQueue(data);
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    }
  }

  async sendQueueControl(action) {
    try {
      const response = await fetch(`/api/queue/${action}`, { method: 'POST' });
      const result = await response.json();
      if (!result.success) {
        console.error(`Queue ${action} failed:`, result.error);
      }
      // Re-fetch queue immediately to update UI
      this.fetchQueue();
    } catch (err) {
      console.error(`Queue ${action} error:`, err);
    }
  }

  updateQueueControls(data) {
    const startBtn = document.getElementById('queue-start-btn');
    const pauseBtn = document.getElementById('queue-pause-btn');
    const isRunning = data?.isRunning ?? false;
    const hasPending = (data?.jobs || []).some(j => j.status === 'pending');

    if (isRunning) {
      startBtn.style.display = 'none';
      pauseBtn.style.display = 'flex';
    } else {
      startBtn.style.display = 'flex';
      startBtn.disabled = !hasPending;
      pauseBtn.style.display = 'none';
    }
  }

  renderQueue(data) {
    if (!data) return;

    this.updateQueueControls(data);

    const jobsContainer = document.getElementById('queue-jobs');
    const emptyEl = document.getElementById('queue-empty');
    const countEl = document.getElementById('queue-count');

    let jobs = data.jobs || [];

    // Separate master (workflow) jobs from standalone jobs
    // Master: has workflowId, no parentJobId, type === 'audiobook'
    // Child: has parentJobId
    // Standalone: no workflowId and no parentJobId
    const masterJobs = [];
    const childByParent = new Map(); // parentJobId -> child[]
    const standaloneJobs = [];

    for (const job of jobs) {
      if (job.parentJobId) {
        if (!childByParent.has(job.parentJobId)) {
          childByParent.set(job.parentJobId, []);
        }
        childByParent.get(job.parentJobId).push(job);
      } else if (job.workflowId && job.type === 'audiobook') {
        masterJobs.push(job);
      } else {
        standaloneJobs.push(job);
      }
    }

    // Build display items: workflows (master + children) and standalone jobs
    const displayItems = [];

    for (const master of masterJobs) {
      const children = childByParent.get(master.id) || [];
      // Workflow-level status: derive from children
      const workflowStatus = this.getWorkflowStatus(master, children);
      displayItems.push({ type: 'workflow', master, children, workflowStatus });
    }

    for (const job of standaloneJobs) {
      displayItems.push({ type: 'job', job });
    }

    // Filter by show-completed
    const filtered = this.showCompleted
      ? displayItems
      : displayItems.filter(item => {
          if (item.type === 'workflow') {
            return item.workflowStatus !== 'complete' && item.workflowStatus !== 'error';
          }
          return item.job.status === 'pending' || item.job.status === 'processing';
        });

    // Sort: processing first
    const statusOrder = { processing: 0, pending: 1, complete: 2, error: 3 };
    filtered.sort((a, b) => {
      const sa = a.type === 'workflow' ? a.workflowStatus : a.job.status;
      const sb = b.type === 'workflow' ? b.workflowStatus : b.job.status;
      return (statusOrder[sa] ?? 9) - (statusOrder[sb] ?? 9);
    });

    // Count all visible top-level items
    countEl.textContent = filtered.length;

    if (filtered.length === 0) {
      jobsContainer.innerHTML = '';
      emptyEl.style.display = 'flex';
      return;
    }

    emptyEl.style.display = 'none';

    const html = filtered.map(item => {
      if (item.type === 'workflow') {
        return this.renderWorkflow(item.master, item.children, item.workflowStatus);
      }
      return this.renderJobCard(item.job);
    }).join('');

    jobsContainer.innerHTML = html;

    // Attach expand/collapse listeners
    jobsContainer.querySelectorAll('.queue-workflow-header').forEach(header => {
      header.addEventListener('click', () => {
        const workflow = header.closest('.queue-workflow');
        const workflowId = workflow.dataset.workflowId;
        workflow.classList.toggle('expanded');
        if (workflow.classList.contains('expanded')) {
          this.expandedWorkflows.add(workflowId);
        } else {
          this.expandedWorkflows.delete(workflowId);
        }
      });
    });
  }

  getWorkflowStatus(master, children) {
    // If master itself has a status, use it for overall display
    if (master.status === 'processing') return 'processing';
    if (children.length === 0) return master.status;

    const hasProcessing = children.some(c => c.status === 'processing');
    const hasError = children.some(c => c.status === 'error');
    const allComplete = children.every(c => c.status === 'complete');
    const allPending = children.every(c => c.status === 'pending');

    if (hasProcessing) return 'processing';
    if (hasError) return 'error';
    if (allComplete && master.status === 'complete') return 'complete';
    if (allPending && master.status === 'pending') return 'pending';
    // Mixed (some complete, some pending) — still in progress
    if (children.some(c => c.status === 'complete') && children.some(c => c.status === 'pending')) return 'processing';
    return master.status;
  }

  getWorkflowProgress(master, children) {
    if (children.length === 0) return Math.round(master.progress || 0);
    const total = children.length;
    let sum = 0;
    for (const child of children) {
      if (child.status === 'complete') {
        sum += 1;
      } else if (child.status === 'processing') {
        sum += (child.progress || 0) / 100;
      }
    }
    return Math.round((sum / total) * 100);
  }

  renderWorkflow(master, children, workflowStatus) {
    const title = master.title || master.epubFilename || master.id;
    const pct = this.getWorkflowProgress(master, children);
    const statusClass = `status-${workflowStatus}`;
    const completedSteps = children.filter(c => c.status === 'complete').length;
    const totalSteps = children.length;
    const isExpanded = workflowStatus === 'processing' || workflowStatus === 'error'
      || this.expandedWorkflows.has(master.id);

    // Step icon for child status
    const stepIcon = (status) => {
      switch (status) {
        case 'complete': return '&#10003;';  // ✓
        case 'processing': return '&#8635;'; // ⟳
        case 'error': return '&#10007;';     // ✗
        default: return '&#9679;';           // ●
      }
    };

    const childrenHtml = children.map(child => {
      const childPct = Math.round(child.progress || 0);
      const childStatusClass = `status-${child.status}`;
      let progressMsg = child.progressMessage || '';
      if (child.ttsPhase === 'converting' && child.ttsConversionProgress != null) {
        progressMsg = `Converting: ${Math.round(child.ttsConversionProgress)}%`;
      } else if (child.ttsPhase === 'assembling' && child.assemblyProgress != null) {
        progressMsg = `Assembling: ${Math.round(child.assemblyProgress)}%` +
          (child.assemblySubPhase ? ` (${child.assemblySubPhase})` : '');
      }
      let etaStr = '';
      if (child.estimatedSecondsRemaining != null && child.estimatedSecondsRemaining > 0 && child.status === 'processing') {
        etaStr = `~${this.formatEta(child.estimatedSecondsRemaining)} remaining`;
      }
      const errorMsg = child.status === 'error' && child.error
        ? `<div class="queue-job-message" style="color: var(--error);">${this.escapeHtml(child.error)}</div>` : '';

      return `
        <div class="queue-job ${childStatusClass}">
          <div class="queue-job-header">
            <span class="workflow-step-icon ${childStatusClass}">${stepIcon(child.status)}</span>
            <span class="queue-job-title">${this.formatJobType(child.type)}</span>
            <span class="queue-job-type type-${child.type}">${this.formatJobType(child.type)}</span>
            <span class="queue-job-status ${childStatusClass}">${child.status}</span>
          </div>
          ${child.status === 'processing' || child.status === 'complete' || child.status === 'error' ? `
            <div class="queue-job-progress">
              <div class="queue-progress-bar">
                <div class="queue-progress-fill" style="width: ${childPct}%"></div>
              </div>
              <span class="queue-progress-pct">${childPct}%</span>
            </div>
          ` : ''}
          ${progressMsg ? `<div class="queue-job-message">${this.escapeHtml(progressMsg)}</div>` : ''}
          ${etaStr ? `<div class="queue-job-eta">${etaStr}</div>` : ''}
          ${errorMsg}
        </div>
      `;
    }).join('');

    return `
      <div class="queue-workflow ${isExpanded ? 'expanded' : ''} ${statusClass}" data-workflow-id="${master.id}">
        <div class="queue-workflow-header">
          <span class="queue-workflow-expand">&#9654;</span>
          <span class="queue-workflow-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</span>
          <div class="queue-workflow-meta">
            <span class="queue-workflow-steps-label">${completedSteps}/${totalSteps} steps</span>
            <span class="queue-job-status ${statusClass}">${workflowStatus}</span>
          </div>
        </div>
        <div class="queue-workflow-progress">
          <div class="queue-progress-bar">
            <div class="queue-progress-fill" style="width: ${pct}%"></div>
          </div>
          <span class="queue-progress-pct">${pct}%</span>
        </div>
        <div class="queue-workflow-children">
          ${childrenHtml}
        </div>
      </div>
    `;
  }

  renderJobCard(job) {
    const title = job.title || job.epubFilename || job.id;
    const typeClass = `type-${job.type}`;
    const statusClass = `status-${job.status}`;
    const pct = Math.round(job.progress || 0);

    let progressMsg = job.progressMessage || '';
    if (job.ttsPhase === 'converting' && job.ttsConversionProgress != null) {
      progressMsg = `Converting: ${Math.round(job.ttsConversionProgress)}%`;
    } else if (job.ttsPhase === 'assembling' && job.assemblyProgress != null) {
      progressMsg = `Assembling: ${Math.round(job.assemblyProgress)}%` +
        (job.assemblySubPhase ? ` (${job.assemblySubPhase})` : '');
    }

    let etaStr = '';
    if (job.estimatedSecondsRemaining != null && job.estimatedSecondsRemaining > 0 && job.status === 'processing') {
      etaStr = `~${this.formatEta(job.estimatedSecondsRemaining)} remaining`;
    }

    const errorMsg = job.status === 'error' && job.error
      ? `<div class="queue-job-message" style="color: var(--error);">${this.escapeHtml(job.error)}</div>` : '';

    return `
      <div class="queue-job ${statusClass}">
        <div class="queue-job-header">
          <span class="queue-job-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</span>
          <span class="queue-job-type ${typeClass}">${this.formatJobType(job.type)}</span>
          <span class="queue-job-status ${statusClass}">${job.status}</span>
        </div>
        <div class="queue-job-progress">
          <div class="queue-progress-bar">
            <div class="queue-progress-fill" style="width: ${pct}%"></div>
          </div>
          <span class="queue-progress-pct">${pct}%</span>
        </div>
        ${progressMsg ? `<div class="queue-job-message">${this.escapeHtml(progressMsg)}</div>` : ''}
        ${etaStr ? `<div class="queue-job-eta">${etaStr}</div>` : ''}
        ${errorMsg}
      </div>
    `;
  }

  formatJobType(type) {
    const labels = {
      'tts-conversion': 'TTS',
      'ocr-cleanup': 'Cleanup',
      'bilingual-cleanup': 'Cleanup',
      'bilingual-translation': 'Translation',
      'translation': 'Translation',
      'bilingual-assembly': 'Assembly',
      'reassembly': 'Reassembly',
      'resemble-enhance': 'Enhance',
      'video-assembly': 'Video',
      'audiobook': 'Audiobook',
    };
    return labels[type] || type;
  }

  formatEta(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Audio Player
  // ─────────────────────────────────────────────────────────────────────────────

  async playBook(book, cardEl) {
    // If same track, toggle play/pause
    if (this.currentTrack && this.currentTrack.book.downloadPath === book.downloadPath) {
      this.togglePlayPause();
      return;
    }

    // Load new track
    const audioUrl = `/api/audio?path=${encodeURIComponent(book.downloadPath)}`;
    this.audioEl.src = audioUrl;
    this.currentTrack = { book, coverDataUrl: null };

    // Show player bar
    this.playerBar.style.display = 'flex';
    document.body.classList.add('player-visible');

    // Set info
    this.playerTitle.textContent = book.title || 'Unknown';
    this.playerAuthor.textContent = book.author || '';

    // Set cover: check if card already has a cover image loaded
    const cardImg = cardEl ? cardEl.querySelector('.book-cover img') : null;
    if (cardImg) {
      this.playerCover.innerHTML = '';
      const img = document.createElement('img');
      img.src = cardImg.src;
      img.alt = 'Cover';
      this.playerCover.appendChild(img);
      this.currentTrack.coverDataUrl = cardImg.src;
    } else {
      this.playerCover.innerHTML = '🎧';
    }

    // Reset seek
    this.playerSeek.value = 0;
    this.playerCurrentTime.textContent = '0:00';
    this.playerDuration.textContent = '0:00';

    // Play
    try {
      await this.audioEl.play();
    } catch (err) {
      console.error('Failed to play audio:', err);
    }

    // Update all card play buttons
    this.updateCardPlayButtons();
  }

  togglePlayPause() {
    if (!this.currentTrack) return;
    if (this.audioEl.paused) {
      this.audioEl.play().catch(() => {});
    } else {
      this.audioEl.pause();
    }
  }

  updatePlayPauseUI(isPlaying) {
    const playIcon = this.playerPlayBtn.querySelector('.play-icon');
    const pauseIcon = this.playerPlayBtn.querySelector('.pause-icon');
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';

    this.updateCardPlayButtons();
  }

  updateCardPlayButtons() {
    // Reset all
    document.querySelectorAll('.card-play-btn').forEach(btn => {
      btn.classList.remove('is-playing');
    });

    // Mark current
    if (this.currentTrack && !this.audioEl.paused) {
      const selector = `.card-play-btn[data-download-path="${CSS.escape(this.currentTrack.book.downloadPath)}"]`;
      const activeBtn = document.querySelector(selector);
      if (activeBtn) {
        activeBtn.classList.add('is-playing');
      }
    }
  }

  getSavedPosition() {
    try {
      const raw = localStorage.getItem('player-position');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
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

        // Detect square/landscape covers and switch to contain mode
        img.onload = () => {
          const ratio = img.naturalWidth / img.naturalHeight;
          if (ratio > 0.85) {
            coverEl.classList.add('square-cover');
          }
        };

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
      const tags = card.dataset.tags || '';
      const matches = !query || title.includes(query) || author.includes(query) || tags.includes(query);
      card.style.display = matches ? '' : 'none';
      if (matches) totalVisible++;
    });

    this.emptyState.style.display = totalVisible === 0 ? 'flex' : 'none';
  }

  downloadAudiobook(book) {
    const displayName = book.outputFilename || book.downloadPath.split(/[/\\]/).pop() || 'audiobook.m4b';
    const url = `/api/download?path=${encodeURIComponent(book.downloadPath)}&filename=${encodeURIComponent(displayName)}`;

    // Let Content-Disposition handle the filename — setting a.download to a filename
    // causes iOS Safari to append a duplicate extension based on MIME type.
    const a = document.createElement('a');
    a.href = url;
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
  const bookshelf = new BookshelfManager();
  bookshelf.init();
});
