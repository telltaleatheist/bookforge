/**
 * BookForge Library Manager
 * Client-side JavaScript for browsing and downloading audiobooks
 */

class LibraryManager {
  constructor() {
    this.allBooks = [];
    this.loadedCovers = new Set();
    this.coverLoadQueue = [];
    this.isLoadingCovers = false;

    // DOM elements
    this.booksContainer = document.getElementById('books-container');
    this.loadingIndicator = document.getElementById('loading-indicator');
    this.emptyState = document.getElementById('empty-state');
    this.searchBox = document.getElementById('search-box');
    this.clearSearch = document.getElementById('clear-search');
    this.loadStatus = document.getElementById('load-status');
    this.totalBooks = document.getElementById('total-books');
    this.themeToggle = document.getElementById('theme-toggle');
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
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
  }

  async loadBooks() {
    try {
      this.loadingIndicator.style.display = 'flex';
      this.emptyState.style.display = 'none';

      const response = await fetch('/api/books');
      const data = await response.json();

      this.allBooks = data.books || [];
      this.totalBooks.textContent = this.allBooks.length;

      if (this.allBooks.length === 0) {
        this.loadingIndicator.style.display = 'none';
        this.emptyState.style.display = 'flex';
        return;
      }

      this.renderBooks();
      this.loadingIndicator.style.display = 'none';

      this.loadCoversProgressively();
    } catch (err) {
      console.error('Failed to load books:', err);
      this.loadStatus.textContent = 'Error loading library';
      this.loadingIndicator.style.display = 'none';
    }
  }

  renderBooks() {
    this.booksContainer.innerHTML = '';
    this.coverLoadQueue = [];

    this.allBooks.forEach((book, index) => {
      const card = this.createBookCard(book, index);
      this.booksContainer.appendChild(card);
    });
  }

  createBookCard(book, delay = 0) {
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

    card.innerHTML = `
      <div class="book-cover">
        <span class="placeholder">🎧</span>
        <span class="book-type-badge m4b">${this.escapeHtml(typeLabel)}</span>
      </div>
      <div class="book-info">
        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
        ${book.author ? `<div class="book-author">${this.escapeHtml(book.author)}</div>` : ''}
        <div class="book-size">${this.formatSize(book.size)}</div>
      </div>
    `;

    card.addEventListener('click', () => this.downloadBook(book));

    this.coverLoadQueue.push({ card, book });

    return card;
  }

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

  downloadBook(book) {
    const displayName = book.outputFilename || book.downloadPath.split('/').pop() || 'audiobook.m4b';
    const url = `/api/download?path=${encodeURIComponent(book.downloadPath)}&filename=${encodeURIComponent(displayName)}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = displayName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  escapeHtml(text) {
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
