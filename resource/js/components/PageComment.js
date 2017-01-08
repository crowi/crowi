// This is the root component for #page-list-search

import React from 'react';
import axios from 'axios'
import SearchResult from './SearchPage/SearchResult';

export default class PageComent extends React.Component {

  render() {
    return (
      <div>
        <form className="form page-comment-form" id="page-comment-form" onsubmit="return false;">
          <div className="comment-form">
            <div className="comment-form-main">
              <div className="comment-write" id="comment-write">
                <textarea className="comment-form-comment form-control" id="comment-form-comment" name="commentForm[comment]"></textarea>
              </div>
              <div className="comment-submit">
                <input type="hidden" name="_csrf" value="{{ csrf() }}">
                <input type="hidden" name="commentForm[page_id]" value="{{ page._id.toString() }}">
                <input type="hidden" name="commentForm[revision_id]" value="{{ revision._id.toString() }}">
                <span className="text-danger" id="comment-form-message"></span>
                <input type="submit" id="comment-form-button" value="Comment" className="btn btn-primary btn-sm form-inline">
              </div>
            </div>
          </div>
        </form>

        <div className="page-comments-list" id="page-comments-list">
          <div className="page-comments-list-newer collapse" id="page-comments-list-newer"></div>

          <a className="page-comments-list-toggle-newer text-center" data-toggle="collapse" href="#page-comments-list-newer"><i className="fa fa-angle-double-up"></i> Comments for Newer Revision <i className="fa fa-angle-double-up"></i></a>

          <div className="page-comments-list-current" id="page-comments-list-current"></div>

          <a className="page-comments-list-toggle-older text-center" data-toggle="collapse" href="#page-comments-list-older"><i className="fa fa-angle-double-down"></i> Comments for Older Revision <i className="fa fa-angle-double-down"></i></a>

          <div className="page-comments-list-older collapse in" id="page-comments-list-older"></div>
        </div>
      </div>
    );
  }
}


