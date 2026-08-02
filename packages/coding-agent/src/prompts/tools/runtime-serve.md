Serve a static directory over HTTP as a supervised background job.

Returns the URL and hub job. Use `hub logs` for output and `hub stop` to release
it. If URL discovery times out, inspect the job logs before declaring failure.
Without hub, report that this session cannot stop the job.
