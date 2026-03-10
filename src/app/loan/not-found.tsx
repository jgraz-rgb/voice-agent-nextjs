export default function LoanNotFound() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-100 text-gray-800">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-base">The requested loan route does not exist.</p>
      </div>
    </div>
  );
}
