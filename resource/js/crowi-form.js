$(function() {
  var pageId = $('#content-main').data('page-id');
  var pagePath= $('#content-main').data('path');

  //require('inline-attachment/src/inline-attachment');
  //require('jquery.selection');
  //require('bootstrap-sass');

  // show/hide
  function FetchPagesUpdatePostAndInsert(path) {
    $.get('/_api/pages.updatePost', {path: path}, function(res) {
      if (res.ok) {
        var $slackChannels = $('#page-form-slack-channel');
        $slackChannels.val(res.updatePost.join(','));
      }
    });
  }

  var slackConfigured = $('#page-form-setting').data('slack-configured');

  // for new page
  if (!pageId) {
    if (slackConfigured) {
      FetchPagesUpdatePostAndInsert(pagePath);
    }
  }

  $('a[data-toggle="tab"][href="#edit-form"]').on('show.bs.tab', function() {
    $('.content-main').addClass('on-edit');

    if (slackConfigured) {
      var $slackChannels = $('#page-form-slack-channel');
      var slackChannels = $slackChannels.val();
      // if slackChannels is empty, then fetch default (admin setting)
      // if not empty, it means someone specified this setting for the page.
      if (slackChannels === '') {
        FetchPagesUpdatePostAndInsert(pagePath);
      }
    }
  });

  $('a[data-toggle="tab"][href="#edit-form"]').on('hide.bs.tab', function() {
    $('.content-main').removeClass('on-edit');
  });

  // preview watch
  var originalContent = $('#form-body').val();
  var prevContent = "";
  var watchTimer = setInterval(function() {
    var content = $('#form-body').val();
    if (prevContent != content) {
      var parsedHTML = crowiRenderer.render(content);
      $('#preview-body').html(parsedHTML);

      prevContent = content;
    }
  }, 500);

  // edit detection
  var isFormChanged = false;
  $(window).on('beforeunload', function(e) {
    if (isFormChanged) {
      return '編集中の内容があります。内容を破棄してページを移動しますか?';
    }
  });
  $('#form-body').on('keyup change', function(e) {
    var content = $('#form-body').val();
    if (originalContent != content) {
      isFormChanged = true;
    } else {
      isFormChanged = false;
    }
  });
  $('#page-form').on('submit', function(e) {
    // avoid message
    isFormChanged = false;
  });

  var getCurrentLine = function(event) {
    var $target = $(event.target);

    var text = $target.val();
    var pos = $target.selection('getPos');
    if (text === null || pos.start !== pos.end) {
      return null;
    }

    var startPos = text.lastIndexOf("\n", pos.start - 1) + 1;
    var endPos = text.indexOf("\n", pos.start);
    if (endPos === -1) {
      endPos = text.length;
    }

    return {
      text: text.slice(startPos, endPos),
      start: startPos,
      end: endPos,
      caret: pos.start,
      endOfLine: !$.trim(text.slice(pos.start, endPos))
    };
  };

  var getPrevLine = function(event) {
    var $target = $(event.target);
    var currentLine = getCurrentLine(event);
    var text = $target.val().slice(0, currentLine.start);
    var startPos = text.lastIndexOf("\n", currentLine.start - 2) + 1;
    var endPos = currentLine.start;

    return {
      text: text.slice(startPos, endPos),
      start: startPos,
      end: endPos
    };
  };

  var handleTabKey = function(event) {
    event.preventDefault();

    var $target = $(event.target);
    var currentLine = getCurrentLine(event);
    var text = $target.val();
    var pos = $target.selection('getPos');

    if (currentLine) {
      $target.selection('setPos', {start: currentLine.start, end: (currentLine.end - 1)});
    }

    if (event.shiftKey === true) {
      if (currentLine && currentLine.text.charAt(0) === '|') {
        // prev cell in table
        var newPos = text.lastIndexOf('|', pos.start - 1);
        if (newPos > 0) {
          $target.selection('setPos', {start: newPos - 1, end: newPos - 1});
        }
      } else {
        // re indent
        var reindentedText = $target.selection().replace(/^ {1,4}/gm, '');
        var reindentedCount = $target.selection().length - reindentedText.length;
        $target.selection('replace', {text: reindentedText, mode: 'before'});
        if (currentLine) {
          $target.selection('setPos', {start: pos.start - reindentedCount, end: pos.start - reindentedCount});
        }
      }
    } else {
      if (currentLine && currentLine.text.charAt(0) === '|') {
        // next cell in table
        var newPos = text.indexOf('|', pos.start + 1);
        if (newPos < 0 || newPos === text.lastIndexOf('|', currentLine.end - 1)) {
          $target.selection('setPos', {start: currentLine.end, end: currentLine.end});
        } else {
          $target.selection('setPos', {start: newPos + 2, end: newPos + 2});
        }
      } else {
        // indent
        $target.selection('replace', {
          text: '    ' + $target.selection().split("\n").join("\n    "),
          mode: 'before'
        });
        if (currentLine) {
          $target.selection('setPos', {start: pos.start + 4, end: pos.start + 4});
        }
      }
    }

    $target.trigger('input');
  };

  var handleEnterKey = function(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }

    var currentLine = getCurrentLine(event);
    if (!currentLine || currentLine.start === currentLine.caret) {
      return;
    }

    var $target = $(event.target);
    var match = currentLine.text.match(/^(\s*(?:-|\+|\*|\d+\.) (?:\[(?:x| )\] )?)\s*\S/);
    if (match) {
      // smart indent with list
      if (currentLine.text.match(/^(\s*(?:-|\+|\*|\d+\.) (?:\[(?:x| )\] ))\s*$/)) {
        // empty task list
        $target.selection('setPos', {start: currentLine.start, end: (currentLine.end - 1)});
        return;
      }
      event.preventDefault();
      var listMark = match[1].replace(/\[x\]/, '[ ]');
      var listMarkMatch = listMark.match(/^(\s*)(\d+)\./);
      if (listMarkMatch) {
        var indent = listMarkMatch[1];
        var num = parseInt(listMarkMatch[2]);
        if (num !== 1) {
          listMark = listMark.replace(/\s*\d+/, indent + (num +1));
        }
      }
      $target.selection('insert', {text: "\n" + listMark, mode: 'before'});
    } else if (currentLine.text.match(/^(\s*(?:-|\+|\*|\d+\.) )/)) {
      // remove list
      $target.selection('setPos', {start: currentLine.start, end: currentLine.end});
    } else if (currentLine.text.match(/^.*\|\s*$/)) {
      // new row for table
      if (currentLine.text.match(/^[\|\s]+$/)) {
        $target.selection('setPos', {start: currentLine.start, end: currentLine.end});
        return;
      }
      if (!currentLine.endOfLine) {
        return;
      }
      event.preventDefault();
      var row = [];
      var cellbarMatch = currentLine.text.match(/\|/g);
      for (var i = 0; i < cellbarMatch.length; i++) {
        row.push('|');
      }
      var prevLine = getPrevLine(event);
      if (!prevLine || (!currentLine.text.match(/---/) && !prevLine.text.match(/\|/g))) {
        $target.selection('insert', {text: "\n" + row.join(' --- ') + "\n" + row.join('  '), mode: 'before'});
        $target.selection('setPos', {start: currentLine.caret + 6 * row.length - 1, end: currentLine.caret + 6 * row.length - 1});
      } else {
        $target.selection('insert', {text: "\n" + row.join('  '), mode: 'before'});
        $target.selection('setPos', {start: currentLine.caret + 3, end: currentLine.caret + 3});
      }
    }

    $target.trigger('input');
  };

  var handleEscapeKey = function(event) {
    event.preventDefault();
    var $target = $(event.target);
    $target.blur();
  };

  var handleSpaceKey = function(event) {
    // keybind: alt + shift + space
    if (!(event.shiftKey && event.altKey)) {
      return;
    }
    var currentLine = getCurrentLine(event);
    if (!currentLine) {
      return;
    }

    var $target = $(event.target);
    var match = currentLine.text.match(/^(\s*)(-|\+|\*|\d+\.) (?:\[(x| )\] )(.*)/);
    if (match) {
      event.preventDefault();
      var checkMark = (match[3] == ' ') ? 'x' : ' ';
      var replaceTo = match[1] + match[2] + ' [' + checkMark + '] ' + match[4];
      $target.selection('setPos', {start: currentLine.start, end: currentLine.end});
      $target.selection('replace', {text: replaceTo, mode: 'keep'});
      $target.selection('setPos', {start: currentLine.caret, end: currentLine.caret});
      $target.trigger('input');
    }
  };

  // markdown helper inspired by 'esarea'.
  // see: https://github.com/fukayatsu/esarea
  $('textarea#form-body').on('keydown', function(event) {
    switch (event.which || event.keyCode) {
      case 9:
        handleTabKey(event);
        break;
      case 13:
        handleEnterKey(event);
        break;
      case 27:
        handleEscapeKey(event);
        break;
      case 32:
        handleSpaceKey(event);
        break;
      default:
    }
  });

  var handlePasteEvent = function(event) {
    var currentLine = getCurrentLine(event);

    if (!currentLine) {
      return false;
    }
    var $target = $(event.target);
    var pasteText = event.clipboardData.getData('text');

    var match = currentLine.text.match(/^(\s*(?:>|\-|\+|\*|\d+\.) (?:\[(?:x| )\] )?)/);
    if (match) {
      if (pasteText.match(/(?:\r\n|\r|\n)/)) {
        pasteText = pasteText.replace(/(\r\n|\r|\n)/g, "$1" + match[1]);
      }
    }

    $target.selection('insert', {text: pasteText, mode: 'after'});

    var newPos = currentLine.end + pasteText.length;
    $target.selection('setPos', {start: newPos, end: newPos});

    return true;
  };

  document.getElementById('form-body').addEventListener('paste', function(event) {
    if (handlePasteEvent(event)) {
      event.preventDefault();
    }
  });

  var unbindInlineAttachment = function($form) {
    $form.unbind('.inlineattach');
  };
  var bindInlineAttachment = function($form, attachmentOption) {
    var $this = $form;
    var editor = createEditorInstance($form);
    var inlineattach = new inlineAttachment(attachmentOption, editor);
    $form.bind({
      'paste.inlineattach': function(e) {
        inlineattach.onPaste(e.originalEvent);
      },
      'drop.inlineattach': function(e) {
        e.stopPropagation();
        e.preventDefault();
        inlineattach.onDrop(e.originalEvent);
      },
      'dragenter.inlineattach dragover.inlineattach': function(e) {
        e.stopPropagation();
        e.preventDefault();
      }
    });
  };
  var createEditorInstance = function($form) {
    var $this = $form;

    return {
      getValue: function() {
        return $this.val();
      },
      insertValue: function(val) {
        inlineAttachment.util.insertTextAtCursor($this[0], val);
      },
      setValue: function(val) {
        $this.val(val);
      }
    };
  };

  var $inputForm = $('form.uploadable textarea#form-body');
  if ($inputForm.length > 0) {
    var pageId = $('#content-main').data('page-id') || 0;
    var attachmentOption = {
      uploadUrl: '/_api/attachment/page/' + pageId,
      extraParams: {
        path: location.pathname
      },
      progressText: '(Uploading file...)',
      urlText: "\n![file]({filename})\n"
    };

    attachmentOption.onFileUploadResponse = function(res) {
      var result = JSON.parse(res.response);

      if (result.status && result.pageCreated) {
        var page = result.page,
            pageId = page._id;

        $('#content-main').data('page-id', page._id);
        $('#page-form [name="pageForm[currentRevision]"]').val(page.revision._id)

        unbindInlineAttachment($inputForm);

        attachmentOption.uploadUrl = '/_api/attachment/page/' + pageId,
        bindInlineAttachment($inputForm, attachmentOption);
      }
      return true;
    };

    bindInlineAttachment($inputForm, attachmentOption);

    $('textarea#form-body').on('dragenter dragover', function() {
      $(this).addClass('dragover');
    });
    $('textarea#form-body').on('drop dragleave dragend', function() {
      $(this).removeClass('dragover');
    });
  }

  var enableScrollSync = function() {
    var getMaxScrollTop = function(dom) {
      var rect = dom.getBoundingClientRect();

      return dom.scrollHeight - rect.height;
    };

    var getScrollRate = function(dom) {
      var maxScrollTop = getMaxScrollTop(dom);
      var rate = dom.scrollTop / maxScrollTop;

      return rate;
    };

    var getScrollTop = function(dom, rate) {
      var maxScrollTop = getMaxScrollTop(dom);
      var top = maxScrollTop * rate;

      return top;
    };

    var editor = document.querySelector('#form-body');
    var preview = document.querySelector('#preview-body');

    editor.addEventListener('scroll', function(event) {
      var rate = getScrollRate(this);
      var top = getScrollTop(preview, rate);

      preview.scrollTop = top;
    });
  };
  enableScrollSync();
});
