import React from 'react';
import PropTypes from 'prop-types';

import * as toastr from 'toastr';
import { throttle, debounce } from 'throttle-debounce';

import GrowiRenderer from '../util/GrowiRenderer';

import { EditorOptions, PreviewOptions } from './PageEditor/OptionsSelector';
import Editor from './PageEditor/Editor';
import Preview from './PageEditor/Preview';
import scrollSyncHelper from './PageEditor/ScrollSyncHelper';

export default class PageEditor extends React.Component {

  constructor(props) {
    super(props);

    const config = this.props.crowi.getConfig();
    const isUploadable = config.upload.image || config.upload.file;
    const isUploadableFile = config.upload.file;
    const isMathJaxEnabled = !!config.env.MATHJAX;

    this.state = {
      revisionId: this.props.revisionId,
      markdown: this.props.markdown,
      isUploadable,
      isUploadableFile,
      isMathJaxEnabled,
      editorOptions: this.props.editorOptions,
      previewOptions: this.props.previewOptions,
    };

    this.growiRenderer = new GrowiRenderer(this.props.crowi, this.props.crowiRenderer, {mode: 'editor'});

    this.setCaretLine = this.setCaretLine.bind(this);
    this.focusToEditor = this.focusToEditor.bind(this);
    this.onMarkdownChanged = this.onMarkdownChanged.bind(this);
    this.onSave = this.onSave.bind(this);
    this.onUpload = this.onUpload.bind(this);
    this.onEditorScroll = this.onEditorScroll.bind(this);
    this.onEditorScrollCursorIntoView = this.onEditorScrollCursorIntoView.bind(this);
    this.onPreviewScroll = this.onPreviewScroll.bind(this);
    this.saveDraft = this.saveDraft.bind(this);
    this.clearDraft = this.clearDraft.bind(this);
    this.pageSavedHandler = this.pageSavedHandler.bind(this);
    this.apiErrorHandler = this.apiErrorHandler.bind(this);

    // for scrolling
    this.lastScrolledDateWithCursor = null;
    this.isOriginOfScrollSyncEditor = false;
    this.isOriginOfScrollSyncEditor = false;

    // create throttled function
    this.scrollPreviewByEditorLineWithThrottle = throttle(20, this.scrollPreviewByEditorLine);
    this.scrollPreviewByCursorMovingWithThrottle = throttle(20, this.scrollPreviewByCursorMoving);
    this.scrollEditorByPreviewScrollWithThrottle = throttle(20, this.scrollEditorByPreviewScroll);
    this.renderWithDebounce = debounce(50, throttle(100, this.renderPreview));
    this.saveDraftWithDebounce = debounce(800, this.saveDraft);
  }

  componentWillMount() {
    // restore draft
    this.restoreDraft();
    // initial rendering
    this.renderPreview(this.state.markdown);
  }

  focusToEditor() {
    this.refs.editor.forceToFocus();
  }

  /**
   * set caret position of editor
   * @param {number} line
   */
  setCaretLine(line) {
    this.refs.editor.setCaretLine(line);
    scrollSyncHelper.scrollPreview(this.previewElement, line);
  }

  /**
   * set options (used from the outside)
   * @param {object} editorOptions
   */
  setEditorOptions(editorOptions) {
    this.setState({ editorOptions });
  }

  /**
   * set options (used from the outside)
   * @param {object} previewOptions
   */
  setPreviewOptions(previewOptions) {
    this.setState({ previewOptions });
  }

  /**
   * the change event handler for `markdown` state
   * @param {string} value
   */
  onMarkdownChanged(value) {
    this.renderWithDebounce(value);
    this.saveDraftWithDebounce()
  }

  /**
   * the save event handler
   */
  onSave() {
    let endpoint;
    let data;

    // update
    if (this.props.pageId != null) {
      endpoint = '/pages.update';
      data = {
        page_id: this.props.pageId,
        revision_id: this.state.revisionId,
        body: this.state.markdown,
      };
    }
    // create
    else {
      endpoint = '/pages.create';
      data = {
        path: this.props.pagePath,
        body: this.state.markdown,
      };
    }

    this.props.crowi.apiPost(endpoint, data)
      .then((res) => {
        // show toastr
        toastr.success(undefined, 'Saved successfully', {
          closeButton: true,
          progressBar: true,
          newestOnTop: false,
          showDuration: "100",
          hideDuration: "100",
          timeOut: "1200",
          extendedTimeOut: "150",
        });

        this.pageSavedHandler(res.page);
      })
      .catch(this.apiErrorHandler)
  }

  /**
   * the upload event handler
   * @param {any} files
   */
  onUpload(file) {
    const endpoint = '/attachments.add';

    // create a FromData instance
    const formData = new FormData();
    formData.append('_csrf', this.props.crowi.csrfToken);
    formData.append('file', file);
    formData.append('path', this.props.pagePath);
    formData.append('page_id', this.props.pageId || 0);

    // post
    this.props.crowi.apiPost(endpoint, formData)
      .then((res) => {
        const url = res.url;
        const attachment = res.attachment;
        const fileName = attachment.originalName;

        let insertText = `[${fileName}](${url})`;
        // when image
        if (attachment.fileFormat.startsWith('image/')) {
          // modify to "![fileName](url)" syntax
          insertText = '!' + insertText;
        }
        this.refs.editor.insertText(insertText);

        // update page information if created
        if (res.pageCreated) {
          this.pageSavedHandler(res.page);
        }
      })
      .catch(this.apiErrorHandler)
      // finally
      .then(() => {
        this.refs.editor.terminateUploadingState();
      });
  }

  /**
   * the scroll event handler from codemirror
   * @param {any} data {left, top, width, height, clientWidth, clientHeight} object that represents the current scroll position, the size of the scrollable area, and the size of the visible area (minus scrollbars).
   *                    And data.line is also available that is added by Editor component
   * @see https://codemirror.net/doc/manual.html#events
   */
  onEditorScroll(data) {
    // prevent scrolling
    //   if the elapsed time from last scroll with cursor is shorter than 40ms
    const now = new Date();
    if (now - this.lastScrolledDateWithCursor < 40) {
      return;
    }

    this.scrollPreviewByEditorLineWithThrottle(data.line);
  }

  /**
   * the scroll event handler from codemirror
   * @param {number} line
   * @see https://codemirror.net/doc/manual.html#events
   */
  onEditorScrollCursorIntoView(line) {
    // record date
    this.lastScrolledDateWithCursor = new Date();
    this.scrollPreviewByCursorMovingWithThrottle(line);
  }

  /**
   * scroll Preview element by scroll event
   * @param {number} line
   */
  scrollPreviewByEditorLine(line) {
    if (this.previewElement == null) {
      return;
    }

    // prevent circular invocation
    if (this.isOriginOfScrollSyncPreview) {
      this.isOriginOfScrollSyncPreview = false; // turn off the flag
      return;
    }

    // turn on the flag
    this.isOriginOfScrollSyncEditor = true;
    scrollSyncHelper.scrollPreview(this.previewElement, line);
  };

  /**
   * scroll Preview element by cursor moving
   * @param {number} line
   */
  scrollPreviewByCursorMoving(line) {
    if (this.previewElement == null) {
      return;
    }

    // prevent circular invocation
    if (this.isOriginOfScrollSyncPreview) {
      this.isOriginOfScrollSyncPreview = false; // turn off the flag
      return;
    }

    // turn on the flag
    this.isOriginOfScrollSyncEditor = true;
    scrollSyncHelper.scrollPreviewToRevealOverflowing(this.previewElement, line);
  };

  /**
   * the scroll event handler from Preview component
   * @param {number} offset
   */
  onPreviewScroll(offset) {
    this.scrollEditorByPreviewScrollWithThrottle(offset);
  }

  /**
   * scroll Editor component by scroll event of Preview component
   * @param {number} offset
   */
  scrollEditorByPreviewScroll(offset) {
    if (this.previewElement == null) {
      return;
    }

    // prevent circular invocation
    if (this.isOriginOfScrollSyncEditor) {
      this.isOriginOfScrollSyncEditor = false;  // turn off the flag
      return;
    }

    // turn on the flag
    this.isOriginOfScrollSyncPreview = true;
    scrollSyncHelper.scrollEditor(this.refs.editor, this.previewElement, offset);
  }

  /*
   * methods for draft
   */
  restoreDraft() {
    // restore draft when the first time to edit
    const draft = this.props.crowi.findDraft(this.props.pagePath);
    if (!this.props.revisionId && draft != null) {
      this.setState({markdown: draft});
    }
  }
  saveDraft() {
    // only when the first time to edit
    if (!this.state.revisionId) {
      this.props.crowi.saveDraft(this.props.pagePath, this.state.markdown);
    }
  }
  clearDraft() {
    this.props.crowi.clearDraft(this.props.pagePath);
  }

  pageSavedHandler(page) {
    // update states
    this.setState({
      revisionId: page.revision._id,
      markdown: page.revision.body
    })

    // clear draft
    this.clearDraft();

    // dispatch onSaveSuccess event
    if (this.props.onSaveSuccess != null) {
      this.props.onSaveSuccess(page);
    }
  }

  apiErrorHandler(error) {
    console.error(error);
    toastr.error(error.message, 'Error occured', {
      closeButton: true,
      progressBar: true,
      newestOnTop: false,
      showDuration: "100",
      hideDuration: "100",
      timeOut: "3000",
    });
  }

  renderPreview(value) {
    const config = this.props.crowi.config;

    this.setState({ markdown: value });

    // render html
    var context = {
      markdown: this.state.markdown,
      dom: this.previewElement,
      currentPagePath: decodeURIComponent(location.pathname)
    };

    const growiRenderer = this.growiRenderer;
    const interceptorManager = this.props.crowi.interceptorManager;
    interceptorManager.process('preRenderPreview', context)
      .then(() => interceptorManager.process('prePreProcess', context))
      .then(() => {
        context.markdown = growiRenderer.preProcess(context.markdown);
      })
      .then(() => interceptorManager.process('postPreProcess', context))
      .then(() => {
        var parsedHTML = growiRenderer.process(context.markdown);
        context['parsedHTML'] = parsedHTML;
      })
      .then(() => interceptorManager.process('prePostProcess', context))
      .then(() => {
        context.parsedHTML = growiRenderer.postProcess(context.parsedHTML, context.dom);
      })
      .then(() => interceptorManager.process('postPostProcess', context))
      .then(() => interceptorManager.process('preRenderPreviewHtml', context))
      .then(() => {
        this.setState({ html: context.parsedHTML });
        // set html to the hidden input (for submitting to save)
        $('#form-body').val(this.state.markdown);
      })
      // process interceptors for post rendering
      .then(() => interceptorManager.process('postRenderPreviewHtml', context));

  }

  render() {
    return (
      <div className="row">
        <div className="col-md-6 col-sm-12 page-editor-editor-container">
          <Editor ref="editor" value={this.state.markdown}
              editorOptions={this.state.editorOptions}
              isUploadable={this.state.isUploadable}
              isUploadableFile={this.state.isUploadableFile}
              onScroll={this.onEditorScroll}
              onScrollCursorIntoView={this.onEditorScrollCursorIntoView}
              onChange={this.onMarkdownChanged}
              onSave={this.onSave}
              onUpload={this.onUpload}
          />
        </div>
        <div className="col-md-6 hidden-sm hidden-xs page-editor-preview-container">
          <Preview html={this.state.html}
              inputRef={el => this.previewElement = el}
              isMathJaxEnabled={this.state.isMathJaxEnabled}
              renderMathJaxOnInit={false}
              previewOptions={this.state.previewOptions}
              onScroll={this.onPreviewScroll}
          />
        </div>
      </div>
    )
  }
}

PageEditor.propTypes = {
  crowi: PropTypes.object.isRequired,
  crowiRenderer: PropTypes.object.isRequired,
  markdown: PropTypes.string.isRequired,
  pageId: PropTypes.string,
  revisionId: PropTypes.string,
  pagePath: PropTypes.string,
  onSaveSuccess: PropTypes.func,
  editorOptions: PropTypes.instanceOf(EditorOptions),
  previewOptions: PropTypes.instanceOf(PreviewOptions),
};
