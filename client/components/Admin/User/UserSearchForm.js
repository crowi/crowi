import React from 'react'
import PropTypes from 'prop-types'

function UserSearchForm({ handleSubmit, handleChange, value }) {
  return (
    <form className="form-group input-group col-xs-6" onSubmit={handleSubmit}>
      {/* q だと事故る (検索欄に入ってしまう) ので、uq にしてます */}
      <input
        autoComplete="off"
        type="text"
        className="form-control"
        placeholder="Search ... User ID, Name and Email /"
        name="uq"
        value={value}
        onChange={handleChange}
      />
      <span className="input-group-append">
        <button type="submit" className="btn btn-outline-secondary">
          <i className="search-top-icon fa fa-search" />
        </button>
      </span>
    </form>
  )
}

UserSearchForm.propTypes = {
  handleSubmit: PropTypes.func.isRequired,
  handleChange: PropTypes.func.isRequired,
  value: PropTypes.string.isRequired,
}

export default UserSearchForm
