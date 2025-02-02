/* global Prism */

// Add smooth scrolling for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Add syntax highlighting to code blocks
document.addEventListener('DOMContentLoaded', () => {
    Prism.highlightAll();
});

// Add scroll-based animations for sections
const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.1
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('opacity-100', 'translate-y-0');
            entry.target.classList.remove('opacity-0', 'translate-y-4');
        }
    });
}, observerOptions);

// Observe all sections
document.querySelectorAll('section').forEach((section) => {
    section.classList.add('transition-all', 'duration-1000', 'opacity-0', 'translate-y-4');
    observer.observe(section);
}); 