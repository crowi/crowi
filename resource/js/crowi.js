/* jshint browser: true, jquery: true */
/* Author: Sotaro KARASAWA <sotarok@crocos.co.jp>
*/

var hljs = require('highlight.js');
var jsdiff = require('diff');
var marked = require('marked');
var io = require('socket.io-client');

//require('bootstrap-sass');
//require('jquery.cookie');

var Crowi = {};

if (!window) {
  window = {};
}
window.Crowi = Crowi;

Crowi.createErrorView = function(msg) {
  $('#main').prepend($('<p class="alert-message error">' + msg + '</p>'));
};

Crowi.linkPath = function(revisionPath) {
  var $revisionPath = revisionPath || '#revision-path';
  var $title = $($revisionPath);
  var pathData = $('#content-main').data('path');

  if (!pathData) {
    return ;
  }

  var realPath = pathData.trim();
  if (realPath.substr(-1, 1) == '/') {
    realPath = realPath.substr(0, realPath.length - 1);
  }

  var path = '';
  var pathHtml = '';
  var splittedPath = realPath.split(/\//);
  splittedPath.shift();
  splittedPath.forEach(function(sub) {
    path += '/';
    pathHtml += ' <a href="' + path + '">/</a> ';
    if (sub) {
      path += sub;
      pathHtml += '<a href="' + path + '">' + sub + '</a>';
    }
  });
  if (path.substr(-1, 1) != '/') {
    path += '/';
    pathHtml += ' <a href="' + path + '" class="last-path">/</a>';
  }
  $title.html(pathHtml);
};

Crowi.correctHeaders = function(contentId) {
  // h1 ~ h6 の id 名を補正する
  var $content = $(contentId || '#revision-body-content');
  var i = 0;
  $('h1,h2,h3,h4,h5,h6', $content).each(function(idx, elm) {
    var id = 'head' + i++;
    $(this).attr('id', id);
    $(this).addClass('revision-head');
    $(this).append('<span class="revision-head-link"><a href="#' + id +'"><i class="fa fa-link"></i></a></span>');
  });
};

Crowi.revisionToc = function(contentId, tocId) {
  var $content = $(contentId || '#revision-body-content');
  var $tocId = $(tocId || '#revision-toc');

  var $tocContent = $('<div id="revision-toc-content" class="revision-toc-content collapse"></div>');
  $tocId.append($tocContent);

  $('h1', $content).each(function(idx, elm) {
    var id = $(this).attr('id');
    var title = $(this).text();
    var selector = '#' + id + ' ~ h2:not(#' + id + ' ~ h1 ~ h2)';

    var $toc = $('<ul></ul>');
    var $tocLi = $('<li><a href="#' + id +'">' + title + '</a></li>');


    $tocContent.append($toc);
    $toc.append($tocLi);

    $(selector).each(function()
    {
      var id2 = $(this).attr('id');
      var title2 = $(this).text();
      var selector2 = '#' + id2 + ' ~ h3:not(#' + id2 + ' ~ h2 ~ h3)';

      var $toc2 = $('<ul></ul>');
      var $tocLi2 = $('<li><a href="#' + id2 +'">' + title2 + '</a></li>');

      $tocLi.append($toc2);
      $toc2.append($tocLi2);

      $(selector2).each(function()
      {
        var id3 = $(this).attr('id');
        var title3 = $(this).text();

        var $toc3 = $('<ul></ul>');
        var $tocLi3 = $('<li><a href="#' + id3 +'">' + title3 + '</a></li>');

        $tocLi2.append($toc3);
        $toc3.append($tocLi3);
      });
    });
  });
};


Crowi.escape = function(s) {
  s = s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    ;
  return s;
};
Crowi.unescape = function(s) {
  s = s.replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    ;
  return s;
};

Crowi.getRendererType = function() {
  return new Crowi.rendererType.markdown();
};

Crowi.rendererType = {};
Crowi.rendererType.markdown = function(){};
Crowi.rendererType.markdown.prototype = {
  render: function(contentText) {

    marked.setOptions({
      gfm: true,
      highlight: function (code, lang, callback) {
        var result, hl;
        if (lang) {
          try {
            hl = hljs.highlight(lang, code);
            result = hl.value;
          } catch (e) {
            result = code;
          }
        } else {
          //result = hljs.highlightAuto(code);
          //callback(null, result.value);
          result = code;
        }
        return callback(null, result);
      },
      tables: true,
      breaks: true,
      pedantic: false,
      sanitize: true,
      smartLists: true,
      smartypants: false,
      langPrefix: 'lang-'
    });

    var contentHtml = Crowi.unescape(contentText);
    // TODO 前処理系のプラグイン化
    contentHtml = this.preFormatMarkdown(contentHtml);
    contentHtml = this.expandImage(contentHtml);
    contentHtml = this.link(contentHtml);

    var $body = this.$revisionBody;
    // Using async version of marked
    marked(contentHtml, {}, function (err, content) {
      if (err) {
        throw err;
      }
      $body.html(content);
    });
  },
  preFormatMarkdown: function(content){
    var x = content
      .replace(/^(#{1,})([^\s]+)?(.*)$/gm, '$1 $2$3') // spacer for section
      .replace(/>[\s]*\n>[\s]*\n/g, '> <br>\n> \n');
    return x;
  },
  link: function (content) {
    return content
      //.replace(/\s(https?:\/\/[\S]+)/g, ' <a href="$1">$1</a>') // リンク
      .replace(/\s<((\/[^>]+?){2,})>/g, ' <a href="$1">$1</a>') // ページ間リンク: <> でかこまれてて / から始まり、 / が2個以上
      ;
  },
  expandImage: function (content) {
    return content.replace(/\s(https?:\/\/[\S]+\.(jpg|jpeg|gif|png))/g, ' <a href="$1"><img src="$1" class="auto-expanded-image"></a>');
  }
};

Crowi.renderer = function (contentText, revisionBody) {
  var $revisionBody = revisionBody || $('#revision-body-content');

  this.contentText = contentText;
  this.$revisionBody = $revisionBody;
  this.format = 'markdown'; // とりあえず
  this.renderer = Crowi.getRendererType();
  this.renderer.$revisionBody = this.$revisionBody;
};
Crowi.renderer.prototype = {
  render: function() {
    this.renderer.render(this.contentText);
  }
};

// original: middleware.swigFilter
Crowi.userPicture = function (user) {
  if (!user) {
    return '/images/userpicture.png';
  }

  if (user.image && user.image != '/images/userpicture.png') {
    return user.image;
  } else if (user.fbId) {
    return '//graph.facebook.com/' + user.fbId + '/picture?size=square';
  } else {
    return '/images/userpicture.png';
  }
};


//CrowiSearcher = function(path, $el) {
//  this.$el = $el;
//  this.path = path;
//  this.searchResult = {};
//};
//CrowiSearcher.prototype.querySearch = function(keyword, option) {
//};
//CrowiSearcher.prototype.search = function(keyword) {
//  var option = {};
//  this.querySearch(keyword, option);
//  this.$el.html(this.render());
//};
//CrowiSearcher.prototype.render = function() {
//  return $('<div>');
//};


$(function() {
  var pageId = $('#content-main').data('page-id');
  var revisionId = $('#content-main').data('page-revision-id');
  var revisionCreatedAt = $('#content-main').data('page-revision-created');
  var currentUser = $('#content-main').data('current-user');
  var isSeen = $('#content-main').data('page-is-seen');
  var pagePath= $('#content-main').data('path');

  Crowi.linkPath();

  $('[data-toggle="popover"]').popover();
  $('[data-toggle="tooltip"]').tooltip();
  $('[data-tooltip-stay]').tooltip('show');

  $('#toggle-sidebar').click(function(e) {
    var $mainContainer = $('.main-container');
    if ($mainContainer.hasClass('aside-hidden')) {
      $('.main-container').removeClass('aside-hidden');
      $.cookie('aside-hidden', 0, { expires: 30, path: '/' });
    } else {
      $mainContainer.addClass('aside-hidden');
      $.cookie('aside-hidden', 1, { expires: 30, path: '/' });
    }
    return false;
  });

  if ($.cookie('aside-hidden') == 1) {
    $('.main-container').addClass('aside-hidden');
  }

  $('.copy-link').on('click', function () {
    $(this).select();
  });

  $('#createMemo').on('shown.bs.modal', function (e) {
    $('#memoName').focus();
  });
  $('#createMemoForm').submit(function(e)
  {
    var prefix = $('[name=memoNamePrefix]', this).val();
    var name = $('[name=memoName]', this).val();
    if (name === '') {
      prefix = prefix.slice(0, -1);
    }
    top.location.href = prefix + name;

    return false;
  });

  $('#renamePage').on('shown.bs.modal', function (e) {
    $('#newPageName').focus();
  });
  $('#renamePageForm').submit(function(e) {
    $.ajax({
      type: 'POST',
      url: '/_api/pages.rename',
      data: $('#renamePageForm').serialize(),
      dataType: 'json'
    }).done(function(res) {
      if (!res.ok) {
        $('#newPageNameCheck').html('<i class="fa fa-times-circle"></i> ' + res.error);
        $('#newPageNameCheck').addClass('alert-danger');
      } else {
        var page = res.page;
        var path = $('#pagePath').html();

        $('#newPageNameCheck').removeClass('alert-danger');
        $('#newPageNameCheck').html('<img src="/images/loading_s.gif"> 移動しました。移動先にジャンプします。');

        setTimeout(function() {
          top.location.href = page.path + '?renamed=' + path;
        }, 1000);
      }
    });

    return false;
  });

  $('#create-portal-button').on('click', function(e) {
    $('.portal').removeClass('hide');
    $('.content-main').addClass('on-edit');
    $('.portal a[data-toggle="tab"][href="#edit-form"]').tab('show');

    var path = $('.content-main').data('path');
    if (path != '/' && $('.content-main').data('page-id') == '') {
      var upperPage = path.substr(0, path.length - 1);
      $.get('/_api/pages.get', {path: upperPage}, function(res) {
        if (res.ok && res.page) {
          $('#portal-warning-modal').modal('show');
        }
      });
    }
  });
  $('#portal-form-close').on('click', function(e) {
    $('.portal').addClass('hide');
    $('.content-main').removeClass('on-edit');

    return false;
  });

  // list-link
  $('.page-list-link').each(function() {
    var $link = $(this);
    var text = $link.text();
    var path = $link.data('path');
    var shortPath = new String($link.data('short-path'));

    var escape = function(s) {
      return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    };
    var pattern = escape(shortPath) + '(/)?$';

    $link.html(path.replace(new RegExp(pattern), '<strong>' + shortPath + '$1</strong>'));
  });

  // for list page
  $('#view-timeline .timeline-body').each(function()
  {
    var id = $(this).attr('id');
    var contentId = '#' + id + ' > script';
    var revisionBody = '#' + id + ' .revision-body';
    var revisionPath = '#' + id + ' .revision-path';
    var renderer = new Crowi.renderer($(contentId).html(), $(revisionBody));
    renderer.render();
  });

  // login
  $('#register').on('click', function() {
    $('#login-dialog').addClass('to-flip');
    return false;
  });
  $('#login').on('click', function() {
    $('#login-dialog').removeClass('to-flip');
    return false;
  });
  $('#btn-login-facebook').click(function(e)
  {
    var afterLogin = function(response) {
      if (response.status !== 'connected') {
        $('#login-form-errors').html('<p class="alert alert-danger">Facebookでのログインに失敗しました。</p>');
      } else {
        location.href = '/login/facebook';
      }
    };
    FB.getLoginStatus(function(response) {
      if (response.status === 'connected') {
        afterLogin(response);
      } else {
        FB.login(function(response) {
          afterLogin(response);
        }, {scope: 'email'});
      }
    });
  });

  $('#register-form input[name="registerForm[username]"]').change(function(e) {
    var username = $(this).val();
    $('#input-group-username').removeClass('has-error');
    $('#help-block-username').html("");

    $.getJSON('/_api/check_username', {username: username}, function(json) {
      if (!json.valid) {
        $('#help-block-username').html('<i class="fa fa-warning"></i>このユーザーIDは利用できません。<br>');
        $('#input-group-username').addClass('has-error');
      }
    });
  });

  $('#btn-register-facebook').click(function(e)
  {
    var afterLogin = function(response) {
      if (response.status !== 'connected') {
        $('#register-form-errors').html('<p class="alert alert-danger">Facebookでのログインに失敗しました。</p>');

      } else {
        var authR = response.authResponse;
        $('#register-form input[name="registerForm[fbId]"]').val(authR.userID);
        FB.api('/me?fields=name,username,email', function(res) {
          $('#register-form input[name="registerForm[name]"]').val(res.name);
          $('#register-form input[name="registerForm[username]"]').val(res.username || '');
          $('#register-form input[name="registerForm[email]"]').val(res.email);

          $('#register-form .facebook-info').remove();
          $('#register-form').prepend('<div class="facebook-info"><img src="//graph.facebook.com/' + res.id + '/picture?size=square" width="25"> <i class="fa fa-facebook-square"></i> ' + res.name + 'さんとして登録します</div>');
        });
      }
    };
    FB.getLoginStatus(function(response) {
      if (response.status === 'connected') {
        afterLogin(response);
      } else {
        FB.login(function(response) {
          afterLogin(response);
        }, {scope: 'email'});
      }
    });
  });

  if (pageId) {

    // if page exists
    var $rawTextOriginal = $('#raw-text-original');
    if ($rawTextOriginal.length > 0) {
      var renderer = new Crowi.renderer($('#raw-text-original').html());
      renderer.render();
      Crowi.correctHeaders('#revision-body-content');
      Crowi.revisionToc('#revision-body-content', '#revision-toc');
    }

    // header
    var $header = $('#page-header');
    if ($header.length > 0) {
      var headerHeight = $header.outerHeight(true);
      $('.header-wrap').css({height: (headerHeight + 16) + 'px'});
      $header.affix({
        offset: {
          top: function() {
            return headerHeight + 86; // (54 header + 16 header padding-top + 16 content padding-top)
          }
        }
      });
      $('[data-affix-disable]').on('click', function(e) {
        $elm = $($(this).data('affix-disable'));
        $(window).off('.affix');
        $elm.removeData('affix').removeClass('affix affix-top affix-bottom');
        return false;
      });
    }

    // omg
    function createCommentHTML(revision, creator, comment, commentedAt) {
      var $comment = $('<div>');
      var $commentImage = $('<img class="picture picture-rounded">')
        .attr('src', Crowi.userPicture(creator));
      var $commentCreator = $('<div class="page-comment-creator">')
        .text(creator.username);

      var $commentRevision = $('<a class="page-comment-revision label">')
        .attr('href', '?revision=' + revision)
        .text(revision.substr(0,8));
      if (revision !== revisionId) {
        $commentRevision.addClass('label-default');
      } else {
        $commentRevision.addClass('label-primary');
      }

      var $commentMeta = $('<div class="page-comment-meta">')
        .text(commentedAt + ' ')
        .append($commentRevision);

      var $commentBody = $('<div class="page-comment-body">')
        .html(comment.replace(/(\r\n|\r|\n)/g, '<br>'));

      var $commentMain = $('<div class="page-comment-main">')
        .append($commentCreator)
        .append($commentBody)
        .append($commentMeta)

      $comment.addClass('page-comment');
      if (creator._id === currentUser) {
        $comment.addClass('page-comment-me');
      }
      if (revision !== revisionId) {
        $comment.addClass('page-comment-old');
      }
      $comment
        .append($commentImage)
        .append($commentMain);

      return $comment;
    }

    // get comments
    var $pageCommentList = $('.page-comments-list');
    var $pageCommentListNewer =   $('#page-comments-list-newer');
    var $pageCommentListCurrent = $('#page-comments-list-current');
    var $pageCommentListOlder =   $('#page-comments-list-older');
    var hasNewer = false;
    var hasOlder = false;
    $.get('/_api/comments.get', {page_id: pageId}, function(res) {
      if (res.ok) {
        var comments = res.comments;
        $.each(comments, function(i, comment) {
          var commentContent = createCommentHTML(comment.revision, comment.creator, comment.comment, comment.createdAt);
          if (comment.revision == revisionId) {
            $pageCommentListCurrent.append(commentContent);
          } else {
            if (Date.parse(comment.createdAt)/1000 > revisionCreatedAt) {
              $pageCommentListNewer.append(commentContent);
              hasNewer = true;
            } else {
              $pageCommentListOlder.append(commentContent);
              hasOlder = true;
            }
          }
        });
      }
    }).fail(function(data) {

    }).always(function() {
      if (!hasNewer) {
        $('.page-comments-list-toggle-newer').hide();
      }
      if (!hasOlder) {
        $pageCommentListOlder.addClass('collapse');
        $('.page-comments-list-toggle-older').hide();
      }
    });

    // post comment event
    $('#page-comment-form').on('submit', function() {
      var $button = $('#comment-form-button');
      $button.attr('disabled', 'disabled');
      $.post('/_api/comments.add', $(this).serialize(), function(data) {
        $button.removeAttr('disabled');
        if (data.ok) {
          var comment = data.comment;

          $pageCommentList.prepend(createCommentHTML(comment.revision, comment.creator, comment.comment, comment.createdAt));
          $('#comment-form-comment').val('');
          $('#comment-form-message').text('');
        } else {
          $('#comment-form-message').text(data.error);
        }
      }).fail(function(data) {
        if (data.status !== 200) {
          $('#comment-form-message').text(data.statusText);
        }
      });

      return false;
    });

    // attachment
    var $pageAttachmentList = $('.page-attachments ul');
    $.get('/_api/attachment/page/' + pageId, function(res) {
      var attachments = res.data.attachments;
      if (attachments.length > 0) {
        $.each(attachments, function(i, file) {
          $pageAttachmentList.append(
          '<li><a href="' + file.fileUrl + '">' + (file.originalName || file.fileName) + '</a> <span class="label label-default">' + file.fileFormat + '</span></li>'
          );
        })
      } else {
        $('.page-attachments').remove();
      }
    });

    // bookmark
    var $bookmarkButton = $('#bookmark-button');
    $.get('/_api/bookmarks.get', {page_id: pageId}, function(res) {
      if (res.ok) {
        if (res.bookmark) {
          MarkBookmarked();
        }
      }
    });

    $bookmarkButton.click(function() {
      var bookmarked = $bookmarkButton.data('bookmarked');
      if (!bookmarked) {
        $.post('/_api/bookmarks.add', {page_id: pageId}, function(res) {
          if (res.ok && res.bookmark) {
            MarkBookmarked();
          }
        });
      } else {
        $.post('/_api/bookmarks.remove', {page_id: pageId}, function(res) {
          if (res.ok) {
            MarkUnBookmarked();
          }
        });
      }

      return false;
    });

    function MarkBookmarked()
    {
      $('i', $bookmarkButton)
        .removeClass('fa-star-o')
        .addClass('fa-star');
      $bookmarkButton.data('bookmarked', 1);
    }

    function MarkUnBookmarked()
    {
      $('i', $bookmarkButton)
        .removeClass('fa-star')
        .addClass('fa-star-o');
      $bookmarkButton.data('bookmarked', 0);
    }

    // Like
    var $likeButton = $('#like-button');
    var $likeCount = $('#like-count');
    $likeButton.click(function() {
      var liked = $likeButton.data('liked');
      if (!liked) {
        $.post('/_api/likes.add', {page_id: pageId}, function(res) {
          if (res.ok) {
            MarkLiked();
          }
        });
      } else {
        $.post('/_api/likes.remove', {page_id: pageId}, function(res) {
          if (res.ok) {
            MarkUnLiked();
          }
        });
      }

      return false;
    });
    var $likerList = $("#liker-list");
    var likers = $likerList.data('likers');
    if (likers && likers.length > 0) {
      // FIXME: user data cache
      $.get('/_api/users.list', {user_ids: likers}, function(res) {
        // ignore unless response has error
        if (res.ok) {
          AddToLikers(res.users);
        }
      });
    }

    function AddToLikers (users) {
      $.each(users, function(i, user) {
        $likerList.append(CreateUserLinkWithPicture(user));
      });
    }

    function MarkLiked()
    {
      $likeButton.addClass('active');
      $likeButton.data('liked', 1);
      $likeCount.text(parseInt($likeCount.text()) + 1);
    }

    function MarkUnLiked()
    {
      $likeButton.removeClass('active');
      $likeButton.data('liked', 0);
      $likeCount.text(parseInt($likeCount.text()) - 1);
    }

    if (!isSeen) {
      $.post('/_api/pages.seen', {page_id: pageId}, function(res) {
        // ignore unless response has error
        if (res.ok && res.seenUser) {
          $('#content-main').data('page-is-seen', 1);
        }
      });
    }

    var $seenUserList = $("#seen-user-list");
    var seenUsers = $seenUserList.data('seen-users');
    var seenUsersArray = seenUsers.split(',');
    if (seenUsers && seenUsersArray.length > 0 && seenUsersArray.length <= 10) {
      // FIXME: user data cache
      $.get('/_api/users.list', {user_ids: seenUsers}, function(res) {
        // ignore unless response has error
        if (res.ok) {
          AddToSeenUser(res.users);
        }
      });
    }

    function CreateUserLinkWithPicture (user) {
      var $userHtml = $('<a>');
      $userHtml.data('user-id', user._id);
      $userHtml.attr('href', '/user/' + user.username);
      $userHtml.attr('title', user.name);

      var $userPicture = $('<img class="picture picture-xs picture-rounded">');
      $userPicture.attr('alt', user.name);
      $userPicture.attr('src',  Crowi.userPicture(user));

      $userHtml.append($userPicture);
      return $userHtml;
    }

    function AddToSeenUser (users) {
      $.each(users, function(i, user) {
        $seenUserList.append(CreateUserLinkWithPicture(user));
      });
    }

    // History Diff
    var allRevisionIds = [];
    $.each($('.diff-view'), function() {
      allRevisionIds.push($(this).data('revisionId'));
    });

    $('.diff-view').on('click', function(e) {
      e.preventDefault();

      var getBeforeRevisionId = function(revisionId) {
        var currentPos = $.inArray(revisionId, allRevisionIds);
        if (currentPos < 0) {
          return false;
        }

        var beforeRevisionId = allRevisionIds[currentPos + 1];
        if (typeof beforeRevisionId === 'undefined') {
          return false;
        }

        return beforeRevisionId;
      };

      var revisionId = $(this).data('revisionId');
      var beforeRevisionId = getBeforeRevisionId(revisionId);
      var $diffDisplay = $('#diff-display-' + revisionId);
      var $diffIcon = $('#diff-icon-' + revisionId);

      if ($diffIcon.hasClass('fa-arrow-circle-right')) {
        $diffIcon.removeClass('fa-arrow-circle-right');
        $diffIcon.addClass('fa-arrow-circle-down');
      } else {
        $diffIcon.removeClass('fa-arrow-circle-down');
        $diffIcon.addClass('fa-arrow-circle-right');
      }

      if (beforeRevisionId === false) {
        $diffDisplay.text('差分はありません');
        $diffDisplay.slideToggle();
      } else {
        var revisionIds = revisionId + ',' + beforeRevisionId;

        $.ajax({
          type: 'GET',
          url: '/_api/revisions.list?revision_ids=' + revisionIds,
          dataType: 'json'
        }).done(function(res) {
          var currentText = res[0].body;
          var previousText = res[1].body;

          $diffDisplay.text('');

          var diff = jsdiff.diffLines(previousText, currentText);
          diff.forEach(function(part) {
            var color = part.added ? 'green' : part.removed ? 'red' : 'grey';
            var $span = $('<span>');
            $span.css('color', color);
            $span.text(part.value);
            $diffDisplay.append($span);
          });

          $diffDisplay.slideToggle();
        });
      }
    });

    // default open
    $('.diff-view').each(function(i, diffView) {
      if (i < 2) {
        $(diffView).click();
      }
    });

    // presentation
    var presentaionInitialized = false
      , $b = $('body');

    $(document).on('click', '.toggle-presentation', function(e) {
      var $a = $(this);

      e.preventDefault();
      $b.toggleClass('overlay-on');

      if (!presentaionInitialized) {
        presentaionInitialized = true;

        $('<iframe />').attr({
          src: $a.attr('href')
        }).appendTo($('#presentation-container'));
      }
    }).on('click', '.fullscreen-layer', function() {
      $b.toggleClass('overlay-on');
    });

    //
    var me = $('body').data('me');
    var socket = io();
    socket.on('page edited', function (data) {
      if (data.user._id != me
        && data.page.path == pagePath) {
        $('#notifPageEdited').show();
        $('#notifPageEdited .edited-user').html(data.user.name);
      }
    });
  } // end if pageId

  // for search
  //
});
