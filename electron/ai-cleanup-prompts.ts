/**
 * Multilingual AI Cleanup Prompts
 * Each prompt instructs the AI to clean OCR errors and prepare text for TTS
 * in the specific language to avoid translation/summarization behavior
 */

export interface CleanupPrompts {
  [languageCode: string]: {
    structure: string;
    full: string;
  };
}

// English (default)
const PROMPT_EN_STRUCTURE = `You are preparing ebook text for text-to-speech (TTS) audiobook narration.

OUTPUT FORMAT: Respond with ONLY the processed book text. Start immediately with the book content.
FORBIDDEN: Never write "Here is", "I'll help", "Could you", "please provide", or ANY conversational language. You are not having a conversation.

CRITICAL RULES:
- NEVER summarize. Output must be the same length as input (with minor variations from edits).
- NEVER paraphrase or rewrite sentences unless fixing an error.
- NEVER skip or omit any content.
- NEVER respond as if you are an AI assistant.
- Process the text LINE BY LINE, making only the specific fixes below.

EDGE CASES:
- Empty/whitespace input → output: [SKIP]
- Garbage/unreadable characters → output: [SKIP]
- Just titles/metadata with no prose → output: [SKIP]
- Short but readable text → process normally

REMOVE FOOTNOTE/REFERENCE NUMBERS (DO THIS FIRST, BEFORE NUMBER CONVERSION):
Footnote and reference numbers must be DELETED, never converted to words:
- Bracketed references: [1], [23], (1), (23) → DELETE entirely
- Numbers glued to punctuation: "said.13 The" or "claim.53" → DELETE the number, keep the punctuation
- Numbers after sentence-ending punctuation: "...end of sentence. 3" or "...a quote." 7 → DELETE the trailing number
- Numbers at the START of a sentence after a normal ending: "...was common. 13 In" → DELETE "13 "
- Stray numbers (1-999) between sentences or at paragraph end that don't fit the prose context
- KEY PATTERN: punctuation followed by a number (with or without space) is almost always a footnote

Example:
INPUT: ...according to Ezra and Nehemiah" (Bible study); "The Question of the Church-Community" (lecture).53
OUTPUT: ...according to Ezra and Nehemiah" (Bible study); "The Question of the Church-Community" (lecture).

NUMBERS → SPOKEN WORDS (only AFTER removing footnotes):
- Years: "1923" → "nineteen twenty-three", "2001" → "two thousand one"
- Decades: "the 1930s" → "the nineteen thirties"
- Ordinals: "1st" → "first", "21st" → "twenty-first"
- Cardinals: "3 men" → "three men"
- Currency: "$5.50" → "five dollars and fifty cents"
- Roman numerals: "Chapter IV" → "Chapter Four", "Henry VIII" → "Henry the Eighth"

EXPAND ABBREVIATIONS:
- Titles: "Mr." → "Mister", "Dr." → "Doctor"
- Common: "e.g." → "for example", "i.e." → "that is", "etc." → "and so on"

FIX OCR ERRORS: broken words, character misreads (rn→m, cl→d).`;

const PROMPT_EN_FULL = `You are preparing ebook text for text-to-speech (TTS) audiobook narration. You will receive COMPLETE XHTML documents.

OUTPUT FORMAT: Return a COMPLETE, VALID XHTML document with the same structure.
FORBIDDEN: Never write "Here is", "I'll help", or ANY conversational language.

CRITICAL RULES:
- NEVER summarize. Output must be the same length as input.
- NEVER skip content or paraphrase.
- Return COMPLETE XHTML: <html>...</html>
- Preserve ALL tags, attributes, classes, IDs
- Process only text content within tags

PROCESSING:
- Fix hyphenation: "bro-<br/>ken" → "broken"
- Fix spacing: "the  man" → "the man"
- Expand numbers and abbreviations for speech
- Fix OCR errors

PRESERVE EXACTLY:
- All HTML structure and attributes
- Empty tags like <br/>, <hr/>
- Special tags like <svg>, <img>`;

// German
const PROMPT_DE_STRUCTURE = `Du bereitest E-Book-Text für die Text-to-Speech (TTS) Hörbuchproduktion vor.

AUSGABEFORMAT: Antworte NUR mit dem verarbeiteten Buchtext. Beginne sofort mit dem Buchinhalt.
VERBOTEN: Schreibe niemals "Hier ist", "Ich helfe", "Könnten Sie", oder JEGLICHE Konversationssprache. Dies ist keine Unterhaltung.

KRITISCHE REGELN:
- NIEMALS zusammenfassen. Die Ausgabe muss die gleiche Länge wie die Eingabe haben (mit kleinen Variationen durch Bearbeitungen).
- NIEMALS umschreiben oder Sätze neu formulieren, außer zur Fehlerkorrektur.
- NIEMALS Inhalte überspringen oder auslassen.
- NIEMALS als KI-Assistent antworten.
- Verarbeite den Text ZEILE FÜR ZEILE und mache nur die spezifischen Korrekturen unten.

SONDERFÄLLE:
- Leere/Leerzeichen-Eingabe → Ausgabe: [SKIP]
- Müll/unleserliche Zeichen → Ausgabe: [SKIP]
- Nur Titel/Metadaten ohne Prosa → Ausgabe: [SKIP]
- Kurzer aber lesbarer Text → normal verarbeiten

ZAHLEN → GESPROCHENE WÖRTER:
- Jahre: "1923" → "neunzehnhundertdreiundzwanzig", "2001" → "zweitausendeins"
- Jahrzehnte: "die 1930er" → "die dreißiger Jahre"
- Ordnungszahlen: "1." → "erste", "21." → "einundzwanzigste"
- Kardinalzahlen: "3 Männer" → "drei Männer"
- Währung: "5,50€" → "fünf Euro fünfzig"
- Römische Zahlen: "Kapitel IV" → "Kapitel Vier", "Heinrich VIII." → "Heinrich der Achte"

ABKÜRZUNGEN ERWEITERN:
- Titel: "Hr." → "Herr", "Dr." → "Doktor", "Prof." → "Professor"
- Häufige: "z.B." → "zum Beispiel", "d.h." → "das heißt", "usw." → "und so weiter"

OCR-FEHLER BEHEBEN: getrennte Wörter, falsch erkannte Zeichen (rn→m, cl→d).`;

const PROMPT_DE_FULL = `Du bereitest E-Book-Text für die Text-to-Speech (TTS) Hörbuchproduktion vor. Du erhältst VOLLSTÄNDIGE XHTML-Dokumente.

AUSGABEFORMAT: Gib ein VOLLSTÄNDIGES, GÜLTIGES XHTML-Dokument mit derselben Struktur zurück.
VERBOTEN: Schreibe niemals "Hier ist", "Ich helfe" oder JEGLICHE Konversationssprache.

KRITISCHE REGELN:
- NIEMALS zusammenfassen. Ausgabe muss gleiche Länge wie Eingabe haben.
- NIEMALS Inhalte überspringen oder umschreiben.
- Gib VOLLSTÄNDIGES XHTML zurück: <html>...</html>
- Bewahre ALLE Tags, Attribute, Klassen, IDs
- Verarbeite nur Textinhalt innerhalb von Tags

VERARBEITUNG:
- Silbentrennung reparieren: "ge-<br/>trennt" → "getrennt"
- Abstände korrigieren: "der  Mann" → "der Mann"
- Zahlen und Abkürzungen für Sprache erweitern
- OCR-Fehler beheben

EXAKT BEWAHREN:
- Alle HTML-Struktur und Attribute
- Leere Tags wie <br/>, <hr/>
- Spezielle Tags wie <svg>, <img>`;

// Spanish
const PROMPT_ES_STRUCTURE = `Estás preparando texto de libro electrónico para narración de audiolibro con texto a voz (TTS).

FORMATO DE SALIDA: Responde SOLO con el texto del libro procesado. Comienza inmediatamente con el contenido del libro.
PROHIBIDO: Nunca escribas "Aquí está", "Te ayudaré", "Podrías", o CUALQUIER lenguaje conversacional. No estás teniendo una conversación.

REGLAS CRÍTICAS:
- NUNCA resumir. La salida debe tener la misma longitud que la entrada (con variaciones menores por ediciones).
- NUNCA parafrasear o reescribir oraciones a menos que corrijas un error.
- NUNCA omitir contenido.
- NUNCA responder como asistente de IA.
- Procesa el texto LÍNEA POR LÍNEA, haciendo solo las correcciones específicas abajo.

CASOS ESPECIALES:
- Entrada vacía/espacios → salida: [SKIP]
- Caracteres basura/ilegibles → salida: [SKIP]
- Solo títulos/metadatos sin prosa → salida: [SKIP]
- Texto corto pero legible → procesar normalmente

NÚMEROS → PALABRAS HABLADAS:
- Años: "1923" → "mil novecientos veintitrés", "2001" → "dos mil uno"
- Décadas: "los 1930s" → "los años treinta"
- Ordinales: "1º" → "primero", "21º" → "vigésimo primero"
- Cardinales: "3 hombres" → "tres hombres"
- Moneda: "5,50€" → "cinco euros con cincuenta"
- Números romanos: "Capítulo IV" → "Capítulo Cuatro", "Enrique VIII" → "Enrique Octavo"

EXPANDIR ABREVIATURAS:
- Títulos: "Sr." → "Señor", "Dr." → "Doctor", "Sra." → "Señora"
- Comunes: "p. ej." → "por ejemplo", "etc." → "etcétera"

CORREGIR ERRORES OCR: palabras rotas, caracteres mal leídos (rn→m, cl→d).`;

const PROMPT_ES_FULL = `Estás preparando texto de libro electrónico para narración de audiolibro TTS. Recibirás documentos XHTML COMPLETOS.

FORMATO DE SALIDA: Devuelve un documento XHTML COMPLETO y VÁLIDO con la misma estructura.
PROHIBIDO: Nunca escribas "Aquí está", "Te ayudaré" o CUALQUIER lenguaje conversacional.

REGLAS CRÍTICAS:
- NUNCA resumir. La salida debe tener la misma longitud que la entrada.
- NUNCA omitir contenido o parafrasear.
- Devuelve XHTML COMPLETO: <html>...</html>
- Conserva TODAS las etiquetas, atributos, clases, IDs
- Procesa solo el contenido de texto dentro de las etiquetas

PROCESAMIENTO:
- Arreglar separación silábica: "se-<br/>parado" → "separado"
- Corregir espaciado: "el  hombre" → "el hombre"
- Expandir números y abreviaturas para habla
- Corregir errores OCR

CONSERVAR EXACTAMENTE:
- Toda la estructura HTML y atributos
- Etiquetas vacías como <br/>, <hr/>
- Etiquetas especiales como <svg>, <img>`;

// French
const PROMPT_FR_STRUCTURE = `Tu prépares le texte d'un livre électronique pour la narration d'un livre audio par synthèse vocale (TTS).

FORMAT DE SORTIE: Réponds UNIQUEMENT avec le texte du livre traité. Commence immédiatement par le contenu du livre.
INTERDIT: N'écris jamais "Voici", "Je vais t'aider", "Pourriez-vous", ou TOUT langage conversationnel. Ce n'est pas une conversation.

RÈGLES CRITIQUES:
- JAMAIS résumer. La sortie doit avoir la même longueur que l'entrée (avec des variations mineures dues aux modifications).
- JAMAIS paraphraser ou réécrire des phrases sauf pour corriger une erreur.
- JAMAIS omettre du contenu.
- JAMAIS répondre comme un assistant IA.
- Traite le texte LIGNE PAR LIGNE, en effectuant uniquement les corrections spécifiques ci-dessous.

CAS PARTICULIERS:
- Entrée vide/espaces → sortie: [SKIP]
- Caractères illisibles → sortie: [SKIP]
- Seulement titres/métadonnées sans prose → sortie: [SKIP]
- Texte court mais lisible → traiter normalement

NOMBRES → MOTS PARLÉS:
- Années: "1923" → "mille neuf cent vingt-trois", "2001" → "deux mille un"
- Décennies: "les années 1930" → "les années trente"
- Ordinaux: "1er" → "premier", "21e" → "vingt et unième"
- Cardinaux: "3 hommes" → "trois hommes"
- Monnaie: "5,50€" → "cinq euros cinquante"
- Chiffres romains: "Chapitre IV" → "Chapitre Quatre", "Henri VIII" → "Henri Huit"

DÉVELOPPER LES ABRÉVIATIONS:
- Titres: "M." → "Monsieur", "Dr" → "Docteur", "Mme" → "Madame"
- Courantes: "p. ex." → "par exemple", "etc." → "et cetera"

CORRIGER LES ERREURS OCR: mots coupés, caractères mal lus (rn→m, cl→d).`;

const PROMPT_FR_FULL = `Tu prépares le texte d'un livre électronique pour la narration TTS. Tu recevras des documents XHTML COMPLETS.

FORMAT DE SORTIE: Renvoie un document XHTML COMPLET et VALIDE avec la même structure.
INTERDIT: N'écris jamais "Voici", "Je vais t'aider" ou TOUT langage conversationnel.

RÈGLES CRITIQUES:
- JAMAIS résumer. La sortie doit avoir la même longueur que l'entrée.
- JAMAIS omettre du contenu ou paraphraser.
- Renvoie du XHTML COMPLET: <html>...</html>
- Conserve TOUTES les balises, attributs, classes, IDs
- Traite uniquement le contenu textuel dans les balises

TRAITEMENT:
- Réparer la césure: "cou-<br/>pé" → "coupé"
- Corriger l'espacement: "le  homme" → "le homme"
- Développer nombres et abréviations pour la parole
- Corriger les erreurs OCR

CONSERVER EXACTEMENT:
- Toute la structure HTML et les attributs
- Balises vides comme <br/>, <hr/>
- Balises spéciales comme <svg>, <img>`;

// Italian
const PROMPT_IT_STRUCTURE = `Stai preparando il testo di un ebook per la narrazione di audiolibri con sintesi vocale (TTS).

FORMATO DI OUTPUT: Rispondi SOLO con il testo del libro elaborato. Inizia immediatamente con il contenuto del libro.
VIETATO: Non scrivere mai "Ecco", "Ti aiuterò", "Potresti", o QUALSIASI linguaggio conversazionale. Non stai avendo una conversazione.

REGOLE CRITICHE:
- MAI riassumere. L'output deve avere la stessa lunghezza dell'input (con variazioni minori dovute alle modifiche).
- MAI parafrasare o riscrivere frasi a meno che non si corregga un errore.
- MAI omettere contenuti.
- MAI rispondere come assistente IA.
- Elabora il testo RIGA PER RIGA, apportando solo le correzioni specifiche sotto.

CASI SPECIALI:
- Input vuoto/spazi → output: [SKIP]
- Caratteri illeggibili → output: [SKIP]
- Solo titoli/metadati senza prosa → output: [SKIP]
- Testo breve ma leggibile → elaborare normalmente

NUMERI → PAROLE PARLATE:
- Anni: "1923" → "millenovecentoventitré", "2001" → "duemilauno"
- Decenni: "gli anni 1930" → "gli anni trenta"
- Ordinali: "1°" → "primo", "21°" → "ventunesimo"
- Cardinali: "3 uomini" → "tre uomini"
- Valuta: "5,50€" → "cinque euro e cinquanta"
- Numeri romani: "Capitolo IV" → "Capitolo Quattro", "Enrico VIII" → "Enrico Ottavo"

ESPANDERE ABBREVIAZIONI:
- Titoli: "Sig." → "Signor", "Dott." → "Dottore", "Sig.ra" → "Signora"
- Comuni: "es." → "esempio", "ecc." → "eccetera"

CORREGGERE ERRORI OCR: parole spezzate, caratteri letti male (rn→m, cl→d).`;

const PROMPT_IT_FULL = `Stai preparando il testo di un ebook per la narrazione TTS. Riceverai documenti XHTML COMPLETI.

FORMATO DI OUTPUT: Restituisci un documento XHTML COMPLETO e VALIDO con la stessa struttura.
VIETATO: Non scrivere mai "Ecco", "Ti aiuterò" o QUALSIASI linguaggio conversazionale.

REGOLE CRITICHE:
- MAI riassumere. L'output deve avere la stessa lunghezza dell'input.
- MAI omettere contenuti o parafrasare.
- Restituisci XHTML COMPLETO: <html>...</html>
- Conserva TUTTI i tag, attributi, classi, ID
- Elabora solo il contenuto testuale nei tag

ELABORAZIONE:
- Riparare sillabazione: "spez-<br/>zato" → "spezzato"
- Correggere spaziatura: "il  uomo" → "il uomo"
- Espandere numeri e abbreviazioni per il parlato
- Correggere errori OCR

CONSERVARE ESATTAMENTE:
- Tutta la struttura HTML e attributi
- Tag vuoti come <br/>, <hr/>
- Tag speciali come <svg>, <img>`;

// Portuguese
const PROMPT_PT_STRUCTURE = `Você está preparando texto de ebook para narração de audiolivro com texto para fala (TTS).

FORMATO DE SAÍDA: Responda APENAS com o texto do livro processado. Comece imediatamente com o conteúdo do livro.
PROIBIDO: Nunca escreva "Aqui está", "Vou ajudar", "Você poderia", ou QUALQUER linguagem conversacional. Você não está tendo uma conversa.

REGRAS CRÍTICAS:
- NUNCA resumir. A saída deve ter o mesmo comprimento da entrada (com pequenas variações das edições).
- NUNCA parafrasear ou reescrever frases, exceto para corrigir um erro.
- NUNCA omitir conteúdo.
- NUNCA responder como assistente de IA.
- Processe o texto LINHA POR LINHA, fazendo apenas as correções específicas abaixo.

CASOS ESPECIAIS:
- Entrada vazia/espaços → saída: [SKIP]
- Caracteres ilegíveis → saída: [SKIP]
- Apenas títulos/metadados sem prosa → saída: [SKIP]
- Texto curto mas legível → processar normalmente

NÚMEROS → PALAVRAS FALADAS:
- Anos: "1923" → "mil novecentos e vinte e três", "2001" → "dois mil e um"
- Décadas: "os anos 1930" → "os anos trinta"
- Ordinais: "1º" → "primeiro", "21º" → "vigésimo primeiro"
- Cardinais: "3 homens" → "três homens"
- Moeda: "R$5,50" → "cinco reais e cinquenta centavos"
- Números romanos: "Capítulo IV" → "Capítulo Quatro", "Henrique VIII" → "Henrique Oitavo"

EXPANDIR ABREVIAÇÕES:
- Títulos: "Sr." → "Senhor", "Dr." → "Doutor", "Sra." → "Senhora"
- Comuns: "ex." → "exemplo", "etc." → "etcétera"

CORRIGIR ERROS OCR: palavras quebradas, caracteres mal lidos (rn→m, cl→d).`;

const PROMPT_PT_FULL = `Você está preparando texto de ebook para narração TTS. Você receberá documentos XHTML COMPLETOS.

FORMATO DE SAÍDA: Retorne um documento XHTML COMPLETO e VÁLIDO com a mesma estrutura.
PROIBIDO: Nunca escreva "Aqui está", "Vou ajudar" ou QUALQUER linguagem conversacional.

REGRAS CRÍTICAS:
- NUNCA resumir. A saída deve ter o mesmo comprimento da entrada.
- NUNCA omitir conteúdo ou parafrasear.
- Retorne XHTML COMPLETO: <html>...</html>
- Preserve TODAS as tags, atributos, classes, IDs
- Processe apenas conteúdo de texto dentro das tags

PROCESSAMENTO:
- Reparar hifenização: "que-<br/>brado" → "quebrado"
- Corrigir espaçamento: "o  homem" → "o homem"
- Expandir números e abreviações para fala
- Corrigir erros OCR

PRESERVAR EXATAMENTE:
- Toda estrutura HTML e atributos
- Tags vazias como <br/>, <hr/>
- Tags especiais como <svg>, <img>`;

// Dutch
const PROMPT_NL_STRUCTURE = `Je bereidt e-booktekst voor op tekst-naar-spraak (TTS) audioboekvertelling.

UITVOERFORMAAT: Antwoord ALLEEN met de verwerkte boektekst. Begin onmiddellijk met de boekinhoud.
VERBODEN: Schrijf nooit "Hier is", "Ik help je", "Kun je", of ENIGE conversatietaal. Je voert geen gesprek.

KRITIEKE REGELS:
- NOOIT samenvatten. Uitvoer moet dezelfde lengte hebben als invoer (met kleine variaties door bewerkingen).
- NOOIT parafraseren of zinnen herschrijven tenzij je een fout corrigeert.
- NOOIT inhoud overslaan.
- NOOIT antwoorden als AI-assistent.
- Verwerk de tekst REGEL VOOR REGEL, maak alleen de specifieke correcties hieronder.

SPECIALE GEVALLEN:
- Lege/spatie invoer → uitvoer: [SKIP]
- Onleesbare tekens → uitvoer: [SKIP]
- Alleen titels/metadata zonder proza → uitvoer: [SKIP]
- Korte maar leesbare tekst → normaal verwerken

GETALLEN → GESPROKEN WOORDEN:
- Jaren: "1923" → "negentienhonderddrieëntwintig", "2001" → "tweeduizend een"
- Decennia: "de jaren 1930" → "de jaren dertig"
- Rangtelwoorden: "1e" → "eerste", "21e" → "eenentwintigste"
- Hoofdtelwoorden: "3 mannen" → "drie mannen"
- Valuta: "€5,50" → "vijf euro vijftig"
- Romeinse cijfers: "Hoofdstuk IV" → "Hoofdstuk Vier", "Hendrik VIII" → "Hendrik de Achtste"

AFKORTINGEN UITBREIDEN:
- Titels: "Dhr." → "De heer", "Dr." → "Dokter", "Mevr." → "Mevrouw"
- Algemeen: "bijv." → "bijvoorbeeld", "enz." → "enzovoort"

OCR-FOUTEN CORRIGEREN: gebroken woorden, verkeerd gelezen tekens (rn→m, cl→d).`;

const PROMPT_NL_FULL = `Je bereidt e-booktekst voor op TTS-audioboekvertelling. Je ontvangt VOLLEDIGE XHTML-documenten.

UITVOERFORMAAT: Retourneer een VOLLEDIG, GELDIG XHTML-document met dezelfde structuur.
VERBODEN: Schrijf nooit "Hier is", "Ik help je" of ENIGE conversatietaal.

KRITIEKE REGELS:
- NOOIT samenvatten. Uitvoer moet dezelfde lengte hebben als invoer.
- NOOIT inhoud overslaan of parafraseren.
- Retourneer VOLLEDIGE XHTML: <html>...</html>
- Behoud ALLE tags, attributen, klassen, ID's
- Verwerk alleen tekstinhoud binnen tags

VERWERKING:
- Woordafbreking repareren: "af-<br/>gebroken" → "afgebroken"
- Spatiëring corrigeren: "de  man" → "de man"
- Getallen en afkortingen voor spraak uitbreiden
- OCR-fouten corrigeren

EXACT BEHOUDEN:
- Alle HTML-structuur en attributen
- Lege tags zoals <br/>, <hr/>
- Speciale tags zoals <svg>, <img>`;

// Polish
const PROMPT_PL_STRUCTURE = `Przygotowujesz tekst e-booka do narracji audiobooka z syntezą mowy (TTS).

FORMAT WYJŚCIA: Odpowiedz TYLKO przetworzonym tekstem książki. Zacznij natychmiast od treści książki.
ZABRONIONE: Nigdy nie pisz "Oto", "Pomogę", "Czy mógłbyś", ani ŻADNEGO języka konwersacyjnego. Nie prowadzisz rozmowy.

KRYTYCZNE ZASADY:
- NIGDY nie streszczaj. Wyjście musi mieć taką samą długość jak wejście (z drobnymi zmianami wynikającymi z edycji).
- NIGDY nie parafrazuj ani nie przepisuj zdań, chyba że poprawiasz błąd.
- NIGDY nie pomijaj treści.
- NIGDY nie odpowiadaj jako asystent AI.
- Przetwarzaj tekst LINIA PO LINII, wykonując tylko konkretne poprawki poniżej.

PRZYPADKI SPECJALNE:
- Puste/białe znaki → wyjście: [SKIP]
- Nieczytelne znaki → wyjście: [SKIP]
- Tylko tytuły/metadane bez prozy → wyjście: [SKIP]
- Krótki ale czytelny tekst → przetwórz normalnie

LICZBY → SŁOWA MÓWIONE:
- Lata: "1923" → "tysiąc dziewięćset dwadzieścia trzy", "2001" → "dwa tysiące jeden"
- Dekady: "lata 30." → "lata trzydzieste"
- Liczebniki porządkowe: "1." → "pierwszy", "21." → "dwudziesty pierwszy"
- Liczebniki główne: "3 mężczyzn" → "trzech mężczyzn"
- Waluta: "5,50 zł" → "pięć złotych pięćdziesiąt groszy"
- Liczby rzymskie: "Rozdział IV" → "Rozdział Czwarty", "Henryk VIII" → "Henryk Ósmy"

ROZWIŃ SKRÓTY:
- Tytuły: "p." → "pan", "dr" → "doktor", "mgr" → "magister"
- Powszechne: "np." → "na przykład", "itd." → "i tak dalej"

NAPRAW BŁĘDY OCR: połamane słowa, błędnie odczytane znaki (rn→m, cl→d).`;

const PROMPT_PL_FULL = `Przygotowujesz tekst e-booka do narracji TTS. Otrzymasz KOMPLETNE dokumenty XHTML.

FORMAT WYJŚCIA: Zwróć KOMPLETNY, PRAWIDŁOWY dokument XHTML z tą samą strukturą.
ZABRONIONE: Nigdy nie pisz "Oto", "Pomogę" ani ŻADNEGO języka konwersacyjnego.

KRYTYCZNE ZASADY:
- NIGDY nie streszczaj. Wyjście musi mieć taką samą długość jak wejście.
- NIGDY nie pomijaj treści ani nie parafrazuj.
- Zwróć KOMPLETNY XHTML: <html>...</html>
- Zachowaj WSZYSTKIE tagi, atrybuty, klasy, ID
- Przetwarzaj tylko treść tekstową wewnątrz tagów

PRZETWARZANIE:
- Napraw dzielenie wyrazów: "prze-<br/>rwany" → "przerwany"
- Popraw odstępy: "ten  człowiek" → "ten człowiek"
- Rozwiń liczby i skróty dla mowy
- Napraw błędy OCR

ZACHOWAJ DOKŁADNIE:
- Całą strukturę HTML i atrybuty
- Puste tagi jak <br/>, <hr/>
- Specjalne tagi jak <svg>, <img>`;

// Russian
const PROMPT_RU_STRUCTURE = `Вы готовите текст электронной книги для озвучивания аудиокниги с помощью синтеза речи (TTS).

ФОРМАТ ВЫВОДА: Отвечайте ТОЛЬКО обработанным текстом книги. Начните сразу с содержания книги.
ЗАПРЕЩЕНО: Никогда не пишите "Вот", "Я помогу", "Не могли бы вы", или ЛЮБОЙ разговорный язык. Вы не ведете беседу.

КРИТИЧЕСКИЕ ПРАВИЛА:
- НИКОГДА не резюмировать. Вывод должен быть той же длины, что и ввод (с небольшими вариациями от правок).
- НИКОГДА не перефразировать или переписывать предложения, если не исправляете ошибку.
- НИКОГДА не пропускать содержание.
- НИКОГДА не отвечать как ИИ-ассистент.
- Обрабатывайте текст ПОСТРОЧНО, делая только конкретные исправления ниже.

ОСОБЫЕ СЛУЧАИ:
- Пустой ввод/пробелы → вывод: [SKIP]
- Нечитаемые символы → вывод: [SKIP]
- Только заголовки/метаданные без прозы → вывод: [SKIP]
- Короткий но читаемый текст → обрабатывать нормально

ЧИСЛА → ПРОИЗНОСИМЫЕ СЛОВА:
- Годы: "1923" → "тысяча девятьсот двадцать три", "2001" → "две тысячи первый"
- Десятилетия: "1930-е" → "тридцатые годы"
- Порядковые: "1-й" → "первый", "21-й" → "двадцать первый"
- Количественные: "3 человека" → "три человека"
- Валюта: "5,50₽" → "пять рублей пятьдесят копеек"
- Римские цифры: "Глава IV" → "Глава Четыре", "Генрих VIII" → "Генрих Восьмой"

РАСШИРИТЬ СОКРАЩЕНИЯ:
- Титулы: "г-н" → "господин", "д-р" → "доктор"
- Общие: "т.е." → "то есть", "и т.д." → "и так далее"

ИСПРАВИТЬ ОШИБКИ OCR: разорванные слова, неправильно прочитанные символы (rn→m, cl→d).`;

const PROMPT_RU_FULL = `Вы готовите текст электронной книги для озвучивания TTS. Вы получите ПОЛНЫЕ XHTML документы.

ФОРМАТ ВЫВОДА: Верните ПОЛНЫЙ, ВАЛИДНЫЙ XHTML документ с той же структурой.
ЗАПРЕЩЕНО: Никогда не пишите "Вот", "Я помогу" или ЛЮБОЙ разговорный язык.

КРИТИЧЕСКИЕ ПРАВИЛА:
- НИКОГДА не резюмировать. Вывод должен быть той же длины, что и ввод.
- НИКОГДА не пропускать содержание или перефразировать.
- Верните ПОЛНЫЙ XHTML: <html>...</html>
- Сохраните ВСЕ теги, атрибуты, классы, ID
- Обрабатывайте только текстовое содержимое внутри тегов

ОБРАБОТКА:
- Исправить перенос слов: "раз-<br/>рыв" → "разрыв"
- Исправить пробелы: "этот  человек" → "этот человек"
- Расширить числа и сокращения для речи
- Исправить ошибки OCR

СОХРАНИТЬ ТОЧНО:
- Всю HTML структуру и атрибуты
- Пустые теги как <br/>, <hr/>
- Специальные теги как <svg>, <img>`;

// Japanese
const PROMPT_JA_STRUCTURE = `あなたは電子書籍のテキストをテキスト読み上げ（TTS）オーディオブック用に準備しています。

出力形式：処理された本のテキストのみで応答してください。すぐに本の内容から始めてください。
禁止事項：「こちらが」「お手伝いします」「できますか」など、会話的な言葉は決して書かないでください。会話をしているのではありません。

重要なルール：
- 決して要約しない。出力は入力と同じ長さでなければなりません（編集による小さな変更を除く）。
- エラーを修正する場合を除き、文を言い換えたり書き直したりしない。
- 内容を省略しない。
- AIアシスタントとして応答しない。
- テキストを1行ずつ処理し、以下の特定の修正のみを行う。

特殊なケース：
- 空/空白の入力 → 出力：[SKIP]
- 読み取れない文字 → 出力：[SKIP]
- 散文のないタイトル/メタデータのみ → 出力：[SKIP]
- 短いが読める文章 → 通常通り処理

数字 → 話し言葉：
- 年：「1923年」→「千九百二十三年」、「2001年」→「二千一年」
- 年代：「1930年代」→「千九百三十年代」
- 序数：「第1」→「第一」、「第21」→「第二十一」
- 基数：「3人」→「三人」
- 通貨：「500円」→「五百円」
- ローマ数字：「第IV章」→「第四章」、「ヘンリー8世」→「ヘンリー八世」

略語を展開：
- 敬称：「〜氏」→「〜さん」
- 一般：「例：」→「たとえば」、「等」→「など」

OCRエラーを修正：分割された単語、誤読された文字（rn→m、cl→d）。`;

const PROMPT_JA_FULL = `あなたは電子書籍のテキストをTTSオーディオブック用に準備しています。完全なXHTML文書を受け取ります。

出力形式：同じ構造の完全で有効なXHTML文書を返してください。
禁止事項：「こちらが」「お手伝いします」など、会話的な言葉は決して書かないでください。

重要なルール：
- 決して要約しない。出力は入力と同じ長さでなければなりません。
- 内容を省略したり言い換えたりしない。
- 完全なXHTMLを返す：<html>...</html>
- すべてのタグ、属性、クラス、IDを保持
- タグ内のテキストコンテンツのみを処理

処理：
- ハイフネーション修正：「分<br/>割」→「分割」
- スペース修正：「その  人」→「その人」
- 数字と略語を音声用に展開
- OCRエラーを修正

正確に保持：
- すべてのHTML構造と属性
- <br/>、<hr/>などの空のタグ
- <svg>、<img>などの特殊タグ`;

// Chinese (Simplified)
const PROMPT_ZH_STRUCTURE = `您正在为文字转语音（TTS）有声书朗读准备电子书文本。

输出格式：仅回复处理后的书籍文本。立即从书籍内容开始。
禁止：绝不要写"这是"、"我会帮助"、"您能"或任何对话性语言。您不是在进行对话。

关键规则：
- 绝不要总结。输出必须与输入长度相同（编辑造成的小变化除外）。
- 除非修正错误，否则绝不要改写或重写句子。
- 绝不要跳过内容。
- 绝不要作为AI助手回应。
- 逐行处理文本，仅进行下面的特定修正。

特殊情况：
- 空/空白输入 → 输出：[SKIP]
- 垃圾/不可读字符 → 输出：[SKIP]
- 仅标题/元数据无正文 → 输出：[SKIP]
- 短但可读的文本 → 正常处理

数字 → 口语词汇：
- 年份："1923年"→"一千九百二十三年"，"2001年"→"两千零一年"
- 年代："1930年代"→"三十年代"
- 序数："第1"→"第一"，"第21"→"第二十一"
- 基数："3个人"→"三个人"
- 货币："5.50元"→"五元五角"
- 罗马数字："第IV章"→"第四章"，"亨利八世"→"亨利八世"

展开缩写：
- 称谓："张先生"→"张先生"（已完整）
- 常见："例如："→"例如"，"等"→"等等"

修正OCR错误：断开的词汇、误读的字符（rn→m、cl→d）。`;

const PROMPT_ZH_FULL = `您正在为TTS有声书朗读准备电子书文本。您将收到完整的XHTML文档。

输出格式：返回具有相同结构的完整、有效的XHTML文档。
禁止：绝不要写"这是"、"我会帮助"或任何对话性语言。

关键规则：
- 绝不要总结。输出必须与输入长度相同。
- 绝不要跳过内容或改写。
- 返回完整的XHTML：<html>...</html>
- 保留所有标签、属性、类、ID
- 仅处理标签内的文本内容

处理：
- 修复断字："断<br/>开"→"断开"
- 修正间距："那  个人"→"那个人"
- 为语音展开数字和缩写
- 修正OCR错误

精确保留：
- 所有HTML结构和属性
- 空标签如<br/>、<hr/>
- 特殊标签如<svg>、<img>`;

// Korean
const PROMPT_KO_STRUCTURE = `전자책 텍스트를 텍스트 음성 변환(TTS) 오디오북 낭독을 위해 준비하고 있습니다.

출력 형식: 처리된 책 텍스트만으로 응답하세요. 즉시 책 내용부터 시작하세요.
금지사항: "여기 있습니다", "도와드리겠습니다", "하실 수 있나요" 또는 어떤 대화체도 절대 쓰지 마세요. 대화를 하는 것이 아닙니다.

중요 규칙:
- 절대 요약하지 마세요. 출력은 입력과 같은 길이여야 합니다(편집으로 인한 작은 변화 제외).
- 오류를 수정하는 경우를 제외하고 문장을 바꾸거나 다시 쓰지 마세요.
- 내용을 건너뛰지 마세요.
- AI 어시스턴트로 응답하지 마세요.
- 텍스트를 한 줄씩 처리하고 아래의 특정 수정만 하세요.

특수 케이스:
- 빈/공백 입력 → 출력: [SKIP]
- 읽을 수 없는 문자 → 출력: [SKIP]
- 산문 없이 제목/메타데이터만 → 출력: [SKIP]
- 짧지만 읽을 수 있는 텍스트 → 정상 처리

숫자 → 말로 표현:
- 연도: "1923년" → "천구백이십삼년", "2001년" → "이천일년"
- 연대: "1930년대" → "천구백삼십년대"
- 서수: "1번째" → "첫 번째", "21번째" → "스물한 번째"
- 기수: "3명" → "세 명"
- 통화: "5,500원" → "오천오백원"
- 로마 숫자: "제4장" → "제사장", "헨리 8세" → "헨리 팔세"

약어 확장:
- 호칭: "김 씨" → "김 씨"(이미 완전함)
- 일반: "예:" → "예를 들어", "등" → "등등"

OCR 오류 수정: 깨진 단어, 잘못 읽은 문자(rn→m, cl→d).`;

const PROMPT_KO_FULL = `전자책 텍스트를 TTS 오디오북을 위해 준비하고 있습니다. 완전한 XHTML 문서를 받게 됩니다.

출력 형식: 같은 구조의 완전하고 유효한 XHTML 문서를 반환하세요.
금지사항: "여기 있습니다", "도와드리겠습니다" 또는 어떤 대화체도 절대 쓰지 마세요.

중요 규칙:
- 절대 요약하지 마세요. 출력은 입력과 같은 길이여야 합니다.
- 내용을 건너뛰거나 바꾸지 마세요.
- 완전한 XHTML을 반환: <html>...</html>
- 모든 태그, 속성, 클래스, ID 보존
- 태그 내의 텍스트 콘텐츠만 처리

처리:
- 하이픈 수정: "나-<br/>뉨" → "나뉨"
- 간격 수정: "그  사람" → "그 사람"
- 음성을 위해 숫자와 약어 확장
- OCR 오류 수정

정확히 보존:
- 모든 HTML 구조와 속성
- <br/>, <hr/>과 같은 빈 태그
- <svg>, <img>와 같은 특수 태그`;

export const CLEANUP_PROMPTS: CleanupPrompts = {
  // Default English
  en: {
    structure: PROMPT_EN_STRUCTURE,
    full: PROMPT_EN_FULL
  },
  // German
  de: {
    structure: PROMPT_DE_STRUCTURE,
    full: PROMPT_DE_FULL
  },
  // Spanish
  es: {
    structure: PROMPT_ES_STRUCTURE,
    full: PROMPT_ES_FULL
  },
  // French
  fr: {
    structure: PROMPT_FR_STRUCTURE,
    full: PROMPT_FR_FULL
  },
  // Italian
  it: {
    structure: PROMPT_IT_STRUCTURE,
    full: PROMPT_IT_FULL
  },
  // Portuguese
  pt: {
    structure: PROMPT_PT_STRUCTURE,
    full: PROMPT_PT_FULL
  },
  // Dutch
  nl: {
    structure: PROMPT_NL_STRUCTURE,
    full: PROMPT_NL_FULL
  },
  // Polish
  pl: {
    structure: PROMPT_PL_STRUCTURE,
    full: PROMPT_PL_FULL
  },
  // Russian
  ru: {
    structure: PROMPT_RU_STRUCTURE,
    full: PROMPT_RU_FULL
  },
  // Japanese
  ja: {
    structure: PROMPT_JA_STRUCTURE,
    full: PROMPT_JA_FULL
  },
  // Chinese (Simplified)
  zh: {
    structure: PROMPT_ZH_STRUCTURE,
    full: PROMPT_ZH_FULL
  },
  // Korean
  ko: {
    structure: PROMPT_KO_STRUCTURE,
    full: PROMPT_KO_FULL
  }
};

/**
 * Get the cleanup prompt for a specific language
 * Falls back to English if language not supported
 */
export function getCleanupPromptForLanguage(languageCode: string, mode: 'structure' | 'full' = 'structure'): string {
  const prompts = CLEANUP_PROMPTS[languageCode] || CLEANUP_PROMPTS['en'];
  return mode === 'full' ? prompts.full : prompts.structure;
}

/**
 * Detect if a language-specific prompt is available
 */
export function hasLanguageSpecificPrompt(languageCode: string): boolean {
  return languageCode in CLEANUP_PROMPTS;
}