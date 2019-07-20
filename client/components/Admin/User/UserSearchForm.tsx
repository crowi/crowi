import React, { FC } from 'react'

interface Props {
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  value: string
}

const UserSearchForm: FC<Props> = ({ handleSubmit, handleChange, value }) => {
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
          <i className="search-top-icon mdi mdi-magnify" />
        </button>
      </span>
    </form>
  )
}

export default UserSearchForm
