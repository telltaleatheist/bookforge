/*
 * The only surface of libxml2 narrator uses: lxml 6.1.1's way of parsing an HTML document
 * and lxml's way of writing one element with its tail. Every call and option below is read
 * from lxml's source (parser.pxi `_parseDoc` and `_HTML_DEFAULT_PARSE_OPTIONS`,
 * serializer.pxi `_tostring`, `_writeNodeToBuffer`, `_writeTail`, etree.pyx's global setup).
 *
 * The Python-level decisions built on these (ebooklib's empty-body rule, the `<body>`
 * wrapper strip, "Document is empty") live in TypeScript. This file holds only what has to
 * touch libxml2's nodes.
 *
 * lxml also copies the parents' namespace declarations onto the copied node. The HTML
 * parser never creates a namespace declaration, so there are none to copy.
 */

#include <stdlib.h>
#include <string.h>

#include <libxml/HTMLparser.h>
#include <libxml/globals.h>
#include <libxml/parser.h>
#include <libxml/tree.h>
#include <libxml/xmlIO.h>
#include <libxml/xmlerror.h>
#include <libxml/xmlsave.h>

#define EXPORT __attribute__((used, visibility("default")))

static void quiet(void *ctx, const char *msg, ...) { (void)ctx; (void)msg; }
static void quiet_structured(void *ctx, const xmlError *err) { (void)ctx; (void)err; }

static htmlParserCtxtPtr parser = NULL;

EXPORT void *bf_alloc(int size) { return malloc((size_t)size); }
EXPORT void bf_free(void *ptr) { free(ptr); }

static int ready(void) {
  if (parser == NULL) {
    xmlInitParser();
    xmlThrDefIndentTreeOutput(1);
    xmlThrDefLineNumbersDefaultValue(1);
    xmlIndentTreeOutput = 1;
    xmlLineNumbersDefaultValue = 1;
    xmlSetGenericErrorFunc(NULL, quiet);
    xmlSetStructuredErrorFunc(NULL, (xmlStructuredErrorFunc)quiet_structured);
    parser = htmlCreateMemoryParserCtxt("dummy", 5);
  }
  return parser != NULL;
}

/* Null when libxml2 returned no document, which lxml raises on. */
EXPORT xmlDocPtr bf_parse(const char *text, int length) {
  if (!ready()) return NULL;
  return htmlCtxtReadMemory(parser, text, length, NULL, "utf-8",
                            HTML_PARSE_RECOVER | HTML_PARSE_NONET | HTML_PARSE_COMPACT);
}

EXPORT void bf_free_doc(xmlDocPtr doc) { xmlFreeDoc(doc); }

/* `doc.getroot()`: null when the document has no element, which `document_fromstring` raises on. */
EXPORT xmlNodePtr bf_root(xmlDocPtr doc) { return xmlDocGetRootElement(doc); }

/* `root.find('body')`: the first child element of that name. */
EXPORT xmlNodePtr bf_find_body(xmlNodePtr root) {
  for (xmlNodePtr child = root->children; child != NULL; child = child->next) {
    if (child->type == XML_ELEMENT_NODE && child->ns == NULL && xmlStrEqual(child->name, BAD_CAST "body")) return child;
  }
  return NULL;
}

/* `len(element)`: lxml counts elements, comments, entity references and processing instructions. */
EXPORT int bf_len(xmlNodePtr element) {
  int count = 0;
  for (xmlNodePtr child = element->children; child != NULL; child = child->next) {
    if (child->type == XML_ELEMENT_NODE || child->type == XML_COMMENT_NODE
        || child->type == XML_ENTITY_REF_NODE || child->type == XML_PI_NODE) count += 1;
  }
  return count;
}

static int result_length = 0;
EXPORT int bf_result_length(void) { return result_length; }

/* `etree.tostring(node, pretty_print=True, encoding='utf-8', xml_declaration=False)`.
 * A malloc'd copy for the caller to `bf_free`, or null. */
EXPORT char *bf_tostring(xmlDocPtr doc, xmlNodePtr node) {
  xmlCharEncodingHandlerPtr handler = xmlFindCharEncodingHandler("utf-8");
  xmlOutputBufferPtr out = xmlAllocOutputBuffer(handler);
  if (out == NULL) return NULL;

  xmlNodePtr copy = xmlCopyNode(node, 2);
  if (copy == NULL) {
    xmlOutputBufferClose(out);
    return NULL;
  }
  copy->parent = node->parent;
  copy->children = node->children;
  copy->last = node->last;
  xmlNodeDumpOutput(out, doc, copy, 0, 1, "utf-8");
  copy->children = copy->last = NULL;
  xmlFreeNode(copy);

  for (xmlNodePtr tail = node->next;
       tail != NULL && !out->error && (tail->type == XML_TEXT_NODE || tail->type == XML_CDATA_SECTION_NODE);
       tail = tail->next) {
    xmlNodeDumpOutput(out, doc, tail, 0, 1, "utf-8");
  }
  xmlOutputBufferWrite(out, 1, "\n");
  xmlOutputBufferFlush(out);

  xmlBufPtr buffer = out->conv != NULL ? out->conv : out->buffer;
  size_t size = xmlBufUse(buffer);
  char *result = NULL;
  if (!out->error) {
    result = malloc(size + 1);
    if (result != NULL) {
      memcpy(result, xmlBufContent(buffer), size);
      result[size] = 0;
      result_length = (int)size;
    }
  }
  xmlOutputBufferClose(out);
  return result;
}

/* `etree.parse(bytes, XMLParser(recover=True, resolve_entities=False))`, ebooklib's `parse_string`:
 * lxml's default options, less NOENT, plus RECOVER. Null when libxml2 returned no document. */
EXPORT xmlDocPtr bf_parse_xml(const char *text, int length) {
  if (!ready()) return NULL;
  return xmlReadMemory(text, length, NULL, NULL,
                       XML_PARSE_NOCDATA | XML_PARSE_NONET | XML_PARSE_COMPACT | XML_PARSE_BIG_LINES | XML_PARSE_RECOVER);
}

/* The tree, as lxml presents it, in a form TypeScript reads without calling back per node.
 * A string is an int32 length, -1 for None, then its bytes. A node is one kind byte (0 element, 1 comment,
 * 2 processing instruction, 3 entity), tag, prefix, then int32 count + (prefix, uri) for each namespace
 * declaration, int32 count + (name, value) for each attribute, text, tail, int32 count + each child. */
static unsigned char *dump_data = NULL;
static size_t dump_size = 0;
static size_t dump_room = 0;
static int dump_failed = 0;

static void dump_bytes(const void *bytes, size_t size) {
  if (dump_failed) return;
  if (dump_size + size > dump_room) {
    size_t room = dump_room ? dump_room * 2 : 65536;
    while (room < dump_size + size) room *= 2;
    unsigned char *grown = realloc(dump_data, room);
    if (grown == NULL) { dump_failed = 1; return; }
    dump_data = grown;
    dump_room = room;
  }
  memcpy(dump_data + dump_size, bytes, size);
  dump_size += size;
}

static void dump_int(int value) { dump_bytes(&value, 4); }

static void dump_string(const xmlChar *text) {
  if (text == NULL) { dump_int(-1); return; }
  int length = xmlStrlen(text);
  dump_int(length);
  dump_bytes(text, (size_t)length);
}

static void dump_name(const xmlNs *ns, const xmlChar *name) {
  if (ns == NULL || ns->href == NULL) { dump_string(name); return; }
  int length = xmlStrlen(ns->href) + xmlStrlen(name) + 2;
  dump_int(length);
  dump_bytes("{", 1);
  dump_bytes(ns->href, (size_t)xmlStrlen(ns->href));
  dump_bytes("}", 1);
  dump_bytes(name, (size_t)xmlStrlen(name));
}

/* lxml's `_collectText`: the text and CDATA nodes from here up to the first node that is neither. */
static void dump_text_run(const xmlNode *node) {
  if (node == NULL || (node->type != XML_TEXT_NODE && node->type != XML_CDATA_SECTION_NODE)) { dump_int(-1); return; }
  int length = 0;
  for (const xmlNode *at = node; at != NULL && (at->type == XML_TEXT_NODE || at->type == XML_CDATA_SECTION_NODE); at = at->next) {
    length += xmlStrlen(at->content);
  }
  dump_int(length);
  for (const xmlNode *at = node; at != NULL && (at->type == XML_TEXT_NODE || at->type == XML_CDATA_SECTION_NODE); at = at->next) {
    if (at->content != NULL) dump_bytes(at->content, (size_t)xmlStrlen(at->content));
  }
}

static int is_lxml_child(const xmlNode *node) {
  return node->type == XML_ELEMENT_NODE || node->type == XML_COMMENT_NODE
      || node->type == XML_ENTITY_REF_NODE || node->type == XML_PI_NODE;
}

static void dump_node(const xmlNode *node) {
  unsigned char kind = node->type == XML_ELEMENT_NODE ? 0 : node->type == XML_COMMENT_NODE ? 1 : node->type == XML_PI_NODE ? 2 : 3;
  dump_bytes(&kind, 1);
  if (kind == 0) {
    dump_name(node->ns, node->name);
    dump_string(node->ns != NULL ? node->ns->prefix : NULL);
    int declarations = 0;
    for (const xmlNs *ns = node->nsDef; ns != NULL; ns = ns->next) declarations += 1;
    dump_int(declarations);
    for (const xmlNs *ns = node->nsDef; ns != NULL; ns = ns->next) {
      dump_string(ns->prefix);
      dump_string(ns->href);
    }
    int attributes = 0;
    for (const xmlAttr *a = node->properties; a != NULL; a = a->next) attributes += 1;
    dump_int(attributes);
    for (const xmlAttr *a = node->properties; a != NULL; a = a->next) {
      dump_name(a->ns, a->name);
      xmlChar *value = a->ns != NULL && a->ns->href != NULL ? xmlGetNsProp(node, a->name, a->ns->href) : xmlGetNoNsProp(node, a->name);
      dump_string(value);
      xmlFree(value);
    }
    dump_text_run(node->children);
  } else {
    dump_string(NULL);
    dump_string(NULL);
    dump_int(0);
    dump_int(0);
    if (kind == 3) {
      int length = xmlStrlen(node->name) + 2;
      dump_int(length);
      dump_bytes("&", 1);
      dump_bytes(node->name, (size_t)xmlStrlen(node->name));
      dump_bytes(";", 1);
    } else {
      dump_string(node->content);
    }
  }
  dump_text_run(node->next);
  int children = 0;
  if (kind == 0) for (const xmlNode *c = node->children; c != NULL; c = c->next) if (is_lxml_child(c)) children += 1;
  dump_int(children);
  if (kind == 0) for (const xmlNode *c = node->children; c != NULL; c = c->next) if (is_lxml_child(c)) dump_node(c);
}

/* A malloc'd dump for the caller to `bf_free`, with its size in `bf_result_length`, or null. */
EXPORT unsigned char *bf_dump(const xmlNode *root) {
  dump_data = NULL;
  dump_size = dump_room = 0;
  dump_failed = 0;
  dump_node(root);
  if (dump_failed) {
    free(dump_data);
    return NULL;
  }
  result_length = (int)dump_size;
  return dump_data;
}
