export interface LibraryBook {
  relativePath: string;      // "Fiction/Title. Author. (2023).epub" - also the ID
  filename: string;          // "Title. Author. (2023).epub"
  title: string;
  subtitle?: string;
  authorFirst?: string;
  authorLast?: string;
  authorFull?: string;       // "LastName, FirstName"
  year?: number;
  language?: string;
  format: string;            // 'epub', 'pdf', 'azw3', etc.
  category: string;          // folder name, e.g. "Fiction"
  fileSize: number;
  coverData?: string;        // base64 data URL (loaded on demand)
  dateAdded: number;
}

export interface Category {
  name: string;
  bookCount: number;
}

export interface DuplicateInfo {
  sourcePath: string;
  existingBook: LibraryBook;
  reason: 'same-title-author' | 'same-file-hash';
}

export interface AddBooksResult {
  added: LibraryBook[];
  duplicates: DuplicateInfo[];
}

export interface UpdateResult {
  book: LibraryBook;
}
