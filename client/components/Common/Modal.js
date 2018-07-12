import React from 'react'

export default class Modal extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      modalShown: false,
    }
  }

  render() {
    if (!this.state.modalShown) {
      return ''
    }

    return (
      <div className="modal in" id="renamePage" style="display: block;">
        <div className="modal-dialog">
          <div className="modal-content">
            <form role="form" id="renamePageForm" onSubmit={() => false}>
              <div className="modal-header">
                <button type="button" className="close" data-dismiss="modal" aria-hidden="true">
                  ×
                </button>
                <h4 className="modal-title">Rename page</h4>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label htmlFor="">Current page name</label>
                  <br />
                  <code>/user/sotarok/memo/2017/04/24</code>
                </div>
                <div className="form-group">
                  <label htmlFor="newPageName">New page name</label>
                  <br />
                  <div className="input-group">
                    <span className="input-group-addon">http://localhost:3000</span>
                    <input
                      type="text"
                      className="form-control"
                      name="new_path"
                      id="newPageName"
                      value="/user/sotarok/memo/2017/04/24"
                    />
                  </div>
                </div>
                <div className="checkbox">
                  <label>
                    <input name="create_redirect" value="1" type="checkbox" /> Redirect
                  </label>
                  <p className="help-block">
                    {' '}
                    Redirect to new page if someone accesses <code>/user/sotarok/memo/2017/04/24</code>
                  </p>
                </div>
              </div>
              <div className="modal-footer">
                <p>
                  <small className="pull-left" id="newPageNameCheck" />
                </p>
                <input type="hidden" name="_csrf" value="RCs7uFdR-4nacCnqKfREe8VIlcYLP2J8xzpU" />
                <input type="hidden" name="path" value="/user/sotarok/memo/2017/04/24" />
                <input type="hidden" name="page_id" value="58fd0bd74c844b8f94c2e5b3" />
                <input type="hidden" name="revision_id" value="58fd126385edfb9d8a0c073a" />
                <input type="submit" className="btn btn-primary" value="Rename!" />
              </div>
            </form>
          </div>
        </div>
      </div>
    )
  }
}
