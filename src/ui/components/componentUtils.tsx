import * as React from 'react';

export function formatComment(comment: string): React.ReactNode {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
  
    return comment.split('\n').map((line, i) => (
      <React.Fragment key={i}>
        {
          line.split(urlRegex).map((chunk, j) =>
            urlRegex.test(chunk) ? (
              <a key={j} href={chunk} target="_blank" rel="noopener noreferrer">
                {chunk}
              </a>
            ) : (
              chunk
            )
          )
        }
        <br />
      </React.Fragment>
    ));
  }

export default { formatComment }