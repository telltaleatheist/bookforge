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

/* Null when libxml2 returned no document, which lxml raises on. */
EXPORT xmlDocPtr bf_parse(const char *text, int length) {
  if (parser == NULL) {
    xmlInitParser();
    xmlThrDefIndentTreeOutput(1);
    xmlThrDefLineNumbersDefaultValue(1);
    xmlIndentTreeOutput = 1;
    xmlLineNumbersDefaultValue = 1;
    xmlSetGenericErrorFunc(NULL, quiet);
    xmlSetStructuredErrorFunc(NULL, (xmlStructuredErrorFunc)quiet_structured);
    parser = htmlCreateMemoryParserCtxt("dummy", 5);
    if (parser == NULL) return NULL;
  }
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
