/**
 * BookForge Library Manager
 * Client-side JavaScript for browsing and downloading books
 */

class LibraryManager {
  constructor() {
    this.sections = [];
    this.allBooks = [];
    this.loadedCovers = new Set();
    this.coverLoadQueue = [];
    this.isLoadingCovers = false;

    // DOM elements
    this.sectionsContainer = document.getElementById('sections-container');
    this.loadingIndicator = document.getElementById('loading-indicator');
    this.emptyState = document.getElementById('empty-state');
    this.searchBox = document.getElementById('search-box');
    this.clearSearch = document.getElementById('clear-search');
    this.loadStatus = document.getElementById('load-status');
    this.totalBooks = document.getElementById('total-books');
    this.totalSections = document.getElementById('total-sections');
    this.themeToggle = document.getElementById('theme-toggle');
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
    await this.loadSections();
  }

  setupTheme() {
    // Load saved theme or default to dark
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
    // Theme toggle
    this.themeToggle.addEventListener('click', () => this.toggleTheme());

    // Search
    this.searchBox.addEventListener('input', () => this.filterBooks());
    this.clearSearch.addEventListener('click', () => {
      this.searchBox.value = '';
      this.clearSearch.style.display = 'none';
      this.filterBooks();
    });
  }

  async loadSections() {
    try {
      this.loadingIndicator.style.display = 'flex';
      this.emptyState.style.display = 'none';

      const response = await fetch('/api/sections');
      const data = await response.json();

      this.sections = data.sections || [];
      this.totalSections.textContent = this.sections.length;

      if (this.sections.length === 0) {
        this.loadingIndicator.style.display = 'none';
        this.emptyState.style.display = 'flex';
        return;
      }

      // Load books for all sections
      await this.loadAllBooks();

      this.renderSections();
      this.loadingIndicator.style.display = 'none';

      // Start loading covers progressively
      this.loadCoversProgressively();
    } catch (err) {
      console.error('Failed to load sections:', err);
      this.loadStatus.textContent = 'Error loading library';
      this.loadingIndicator.style.display = 'none';
    }
  }

  async loadAllBooks() {
    this.allBooks = [];
    let totalCount = 0;

    for (const section of this.sections) {
      try {
        const response = await fetch(`/api/books/${encodeURIComponent(section.path)}`);
        const data = await response.json();

        if (data.books) {
          // Add section info to each book
          data.books.forEach(book => {
            book.section = section.name;
            book.sectionPath = section.path;
          });

          section.books = data.books;
          this.allBooks.push(...data.books);
          totalCount += data.books.length;
        }
      } catch (err) {
        console.error(`Failed to load books for section ${section.name}:`, err);
        section.books = [];
      }
    }

    this.totalBooks.textContent = totalCount;
  }

  renderSections() {
    this.sectionsContainer.innerHTML = '';

    for (const section of this.sections) {
      if (!section.books || section.books.length === 0) continue;

      const sectionEl = document.createElement('div');
      sectionEl.className = 'section collapsed';  // Start collapsed by default
      sectionEl.dataset.section = section.path;

      sectionEl.innerHTML = `
        <div class="section-header">
          <div class="section-title">
            <h2>${this.escapeHtml(section.name)}</h2>
            <span class="section-count">${section.books.length}</span>
          </div>
          <span class="section-toggle">▼</span>
        </div>
        <div class="section-books"></div>
      `;

      // Toggle section collapse
      const header = sectionEl.querySelector('.section-header');
      header.addEventListener('click', () => {
        sectionEl.classList.toggle('collapsed');
        // Save expand state (true = expanded, false/missing = collapsed)
        const expanded = JSON.parse(localStorage.getItem('expanded-sections') || '{}');
        expanded[section.path] = !sectionEl.classList.contains('collapsed');
        localStorage.setItem('expanded-sections', JSON.stringify(expanded));
      });

      // Restore expand state (sections are collapsed by default, open if explicitly expanded)
      const expanded = JSON.parse(localStorage.getItem('expanded-sections') || '{}');
      if (expanded[section.path]) {
        sectionEl.classList.remove('collapsed');
      }

      const booksContainer = sectionEl.querySelector('.section-books');
      section.books.forEach((book, index) => {
        const bookCard = this.createBookCard(book, index);
        booksContainer.appendChild(bookCard);
      });

      this.sectionsContainer.appendChild(sectionEl);
    }
  }

  createBookCard(book, delay = 0) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.style.animationDelay = `${delay * 0.03}s`;
    card.dataset.path = book.path;
    card.dataset.title = book.title.toLowerCase();

    const typeIcons = {
      'epub': '📖',
      'pdf': '📄',
      'm4b': '🎧',
      'unknown': '📁'
    };

    card.innerHTML = `
      <div class="book-cover">
        <span class="placeholder">${typeIcons[book.type] || '📁'}</span>
        <span class="book-type-badge ${book.type}">${book.type}</span>
      </div>
      <div class="book-info">
        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
        ${book.author ? `<div class="book-author">${this.escapeHtml(book.author)}</div>` : ''}
        <div class="book-size">${this.formatSize(book.size)}</div>
      </div>
    `;

    // Click to download
    card.addEventListener('click', () => this.downloadBook(book));

    // Queue cover load (include sectionPath for proper path construction)
    this.coverLoadQueue.push({ card, book, sectionPath: book.sectionPath });

    return card;
  }

  async loadCoversProgressively() {
    if (this.isLoadingCovers || this.coverLoadQueue.length === 0) return;

    this.isLoadingCovers = true;

    // Create a map of card elements to their book data
    const cardDataMap = new Map();
    this.coverLoadQueue.forEach(({ card, book, sectionPath }) => {
      cardDataMap.set(card, { book, sectionPath });
    });

    // Use IntersectionObserver for lazy loading
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          const bookPath = card.dataset.path;
          const data = cardDataMap.get(card);

          if (!this.loadedCovers.has(bookPath) && data) {
            this.loadCover(card, bookPath, data.sectionPath);
            this.loadedCovers.add(bookPath);
          }

          observer.unobserve(card);
        }
      });
    }, {
      rootMargin: '100px',
      threshold: 0
    });

    // Observe all book cards
    this.coverLoadQueue.forEach(({ card }) => {
      observer.observe(card);
    });

    this.isLoadingCovers = false;
  }

  async loadCover(card, bookPath, sectionPath) {
    try {
      // Construct full path like downloadBook does
      const fullPath = sectionPath === '.' ? bookPath : `${sectionPath}/${bookPath}`;
      const response = await fetch(`/api/cover?path=${encodeURIComponent(fullPath)}`);
      const data = await response.json();

      if (data.cover) {
        const coverEl = card.querySelector('.book-cover');
        const img = document.createElement('img');
        img.src = data.cover;
        img.alt = 'Cover';
        img.loading = 'lazy';

        // Replace placeholder with image
        const placeholder = coverEl.querySelector('.placeholder');
        if (placeholder) {
          placeholder.style.display = 'none';
        }
        coverEl.insertBefore(img, coverEl.firstChild);
      }
    } catch (err) {
      console.error('Failed to load cover:', bookPath, err);
    }
  }

  filterBooks() {
    const query = this.searchBox.value.toLowerCase().trim();
    this.clearSearch.style.display = query ? 'block' : 'none';

    const sections = this.sectionsContainer.querySelectorAll('.section');
    let totalVisible = 0;

    sections.forEach(section => {
      const cards = section.querySelectorAll('.book-card');
      let visibleInSection = 0;

      cards.forEach(card => {
        const title = card.dataset.title;
        const matches = !query || title.includes(query);
        card.style.display = matches ? '' : 'none';
        if (matches) visibleInSection++;
      });

      // Update section count
      const countEl = section.querySelector('.section-count');
      countEl.textContent = visibleInSection;

      // Hide section if no visible books
      section.style.display = visibleInSection > 0 ? '' : 'none';
      totalVisible += visibleInSection;
    });

    // Show empty state if no results
    this.emptyState.style.display = totalVisible === 0 ? 'flex' : 'none';
  }

  downloadBook(book) {
    const fullPath = book.sectionPath === '.'
      ? book.path
      : `${book.sectionPath}/${book.path}`;

    const url = `/api/download?path=${encodeURIComponent(fullPath)}`;

    // Create temporary link and click it
    const a = document.createElement('a');
    a.href = url;
    a.download = book.filename;
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
